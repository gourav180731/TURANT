# TURANT v0.1.0 — Pseudocode

**Version:** 0.1.0  
**Source HEAD:** `22ab6a1ac9ba2599b8244ca8b9d81d295ca308a8` → `bb08b3d` (248/248 BUILD SUCCESS, `target/turant-0.1.0.jar` `3E3CF814664E9435906F61A8B28C8211924E96258299F750AC8DC26A726D7660`)  
**Stack:** Java 22.0.2, Spring Boot 3.2.2, PostgreSQL 16 + PostGIS 3.4 (JTS 1.19.0, postgis-jdbc 2023.1.0), jSMPP 3.0.1, H2 2.2.224 (test), Maven 3.10.0-rc-1  
**Scope:** Canonical pipeline as implemented — `src/main/java/com/turant/` is source of truth. All references use `file_path:line_number` for navigation.

> This document is derived by inspection — no business logic was changed to produce it. Historical numbers use actual run values (248/248 with SMPPSim `127.0.0.1:5555`).

---

## 1. High-Level Architecture

```pseudocode
C-DOT EWS -> HTTPS mTLS/API-Key -> TURANT API Gateway (ApiKeyAuthFilter, MtlsAuthFilter)
          -> PipelineController.triggerByCap -> CapIngestionService -> CapParser (XXE-hardened)
          -> AlertPipeline (Activities 1-14)
              -> TowerResolver (PostGisTowerSource | SimulatedTowerSource)
              -> SubscriberCellStatsService (O(k) agg) | VlrProbeService | SubscriberPrefetchService
              -> MsisdnDeduplicator -> ExpiryGuard -> ValidityPeriod -> PriorityFlags
              -> BatchFileSMSCService -> SmppClient (jSMPP BIND_TRX) -> SMSC (SMPPSim or real TSP)
              -> DlrListener + DlrReporter (deliver_sm) -> EwsService (LocalEwsClient | RemoteEwsClient)
              -> PipelineStatusStore -> Report
          -> EWS polling GET /status, /towers, /report
PostgreSQL+PostGIS (sim_cell_towers, subscriber_dump, cell_subscriber_stats, turant_agg, security_audit, cap_replay, client_credentials)
Redis 7 (Lettuce, optional) • Postman S01-S19 security matrix
```

---

## 2. System Entry — `src/main/java/com/turant/pipeline/PipelineController.java:94` `com/turant/http/HealthController.java:39`

```pseudocode
GET /healthz (HealthController:39)  // public, permitAll
  db = (DataSource==null ? not_configured : jdbc.queryForObject("SELECT 1") ? ok : error)
  redis = (RedisTemplate==null ? not_configured : ping ? ok : error)
  smpp = (SmppClient.isConfigured() ? configured : awaiting_credentials)
  status = (db in (ok,not_configured) && redis in (ok,not_configured)) ? healthy : degraded
  RETURN 200 {app:turant, uptimeSeconds, db, redis, smpp, status}

POST /api/v1/pipeline/trigger-by-cap  // PipelineController:94 triggerByCap(@RequestBody String capXml)
  // Security: ApiKeyAuthFilter:27 Ordered+H10 checks X-API-KEY|X-EWS-API-KEY|Authorization: Bearer <key>
  //          vs EWS_API_KEY (turant.security.api-key:${EWS_API_KEY:} application.properties:255)
  //          if empty -> pass-through (dev), else 401 UNAUTHORIZED ApiError code:UNAUTHORIZED
  IF capXml == null OR blank -> 400 EMPTY_CAP {code:EMPTY_CAP}
  IF capXml.length > 20971520 (20MB application.properties:11) -> 413 CAP_TOO_LARGE
  // CAP ingestion
  CapAlert alert = CapIngestionService.ingestCap(capXml:122)
    DocumentBuilderFactory: CapParser:34 disallow-doctype:true:41 external-general-entities:false:44
      load-external-dtd:false:48 secure-processing:true:51 XInclude:false:53 ACCESS_EXTERNAL_DTD:"":60
      entityExpansionLimit 10000:62 totalEntitySizeLimit 50000:63
    CapParser.parseCapXml(xml) validates requiredText identifier, sender, sent (ISO8601), status, msgType, scope
      info[0].event, area[polygon circle] polygon lat,lng closed ring >=4 first==last else CapParseException:400
    -> INSERT INTO alerts (cap_identifier,sender,raw_xml) ON CONFLICT (cap_identifier,sender) DO UPDATE
    ReplayProtectionService.checkAndMark(cap_identifier,sender):33 INSERT cap_replay -> duplicate PK => 409 REPLAY_DETECTED
  PipelineStatusRecord rec = AlertPipeline.runAlertPipeline(RunPipelineInput(alert, capId, capId, TowerSourceOverride)).get(300s)
    IF TimeoutException -> GlobalExceptionHandler:18 503 PIPELINE_TIMEOUT, status=halted stage=tower_resolution
  RETURN 200 TriggerResponse(capIdentifier, alertId, action:triggered, status:completed|halted|running, stage:done)
GET /api/v1/pipeline/status/{capId}  // PipelineController:158 getStatus -> PipelineStatusStore.get
  RETURN 200 PipelineStatusRecord:8 {capIdentifier, status, stage, haltedAt, reason, towerCount, matchedCount,
                                     duplicatesRemoved, expectedRecipients, submittedCount, acceptedCount,
                                     awaitingCredentials, updatedAtMs}
GET /api/v1/pipeline/towers/{capId}  // PipelineController:174
  RETURN 200 TowersResponse:244 {capIdentifier, count, towers[{id:site_id, cellId, lat, lng, coverageRadiusM}]}
GET /api/v1/pipeline/report/{capId} // PipelineController:192 -> 202 REPORT_NOT_READY if status!=completed else AlertReport
DELETE /api/v1/pipeline/status/{capId} // PipelineController:235
```

---

## 3. Alert Pipeline Orchestrator — `src/main/java/com/turant/pipeline/AlertPipeline.java:14-activities`

```pseudocode
class AlertPipeline:
  dependencies: TowerResolver, SubscriberCellStatsService, VlrProbeService, MsisdnDeduplicator,
                ExpiryGuard, ValidityPeriod, PriorityFlags, BatchFileSMSCService, SmppClient,
                DlrReporter, EwsService, PipelineStatusStore, ReportBuilder

  CompletableFuture<PipelineStatusRecord> runAlertPipeline(input):
    start = now()
    capId = input.alert.identifier
    // ---- Activity 5 Expiry ----
    CapTiming t = CapParser.parseCapTiming(alert.info.expires) // application.properties:76
    validity = ValidityPeriod.toSmppValidityPeriod(t.expiresAt) // ValidityPeriod.java:248 16-char absolute 2609081247000000
    priority = PriorityFlags.earlyWarningPriorityFlag() // PriorityFlags.java -> 3
    IF turant.expiry.halt-submission:true AND t.expiresAt < now():
      store halted reason=EXPIRED; DLR delivered 0; RETURN halted

    // ---- GeoZone ----
    GeoZone zone = buildGeoZone(alert) // info[].area[].polygon -> List<List<CapCoordinate>> closed, circle -> CircleDefinition(lat,lng,radiusKm*1000)
                                      // JTS GeometryFactory SRID4326, polygon via linear ring
    log GeoZone(geometries.size=1..N, srid=4326, geometries[0]=Circle center 28.6139,77.209 radius 15000)

    // ---- Activity 1 Tower Resolution ----
    // TowerResolver.java:81
    source = input.overrideSource != null ? input.overrideSource : registry[ tower.source-mode:${TOWER_SOURCE_MODE:postgis} application.properties:59 ]
    // Guards TowerResolver:81-142
    IF simulation.mode==disabled AND source instanceof SimulatedTowerSource -> throw IllegalStateException REAL MODE VIOLATION
    IF registry[configured] missing -> throw IllegalStateException
    result = source.findTowersInZone(zone, FindTowersOptions{budgetMs 5000, limit 100000}).orTimeout(5000)
      IF source==postgis: PostGisTowerSource.java:42 SELECT site_id,cell_id,latitude,longitude,coverage_radius_m
                         FROM sim_cell_towers WHERE ST_Within(geom, ST_Collect(ST_Simplify(...))) // PostGIS
      IF source==simulated: SimulatedTowerSource.java:30 deterministic 5-50 towers per geometry within zone spread 5km
    // TowerResolver dedup by site_id, perGeometryCounts, duplicatesRemovedAtSource
    towerCount = result.towers.size; perGeometryCounts; duplicatesRemovedSource
    pipelineDedup: unique by site_id -> finalTowers, duplicatesRemovedPipeline
    log TOWER_RESOLUTION_COMPLETE raw=5 final=5 duplicatesRemoved=0 perGeometryCounts=[5]

    // ---- Activity 2 Prefetch (speculative, async) ----
    // SubscriberPrefetchService.java:55 @Scheduled refreshMs 43200000 (12h) storageDir ./data/prefetch
    // streamTechToFile: SELECT serving_cell_id,msisdn,imsi FROM subscriber_dump WHERE technology IN (...) AND serving_cell_id IS NOT NULL -> file per tech

    // ---- Activity 3 Subscriber Matching (optimized) ----
    cellIds = finalTowers.map(t -> cellId).filter(nonBlank).distinct() // 5 distinct
    // SubscriberCellStatsService.java:303 countAndDistinctByCellIds(cellIds) — see §4
    [matchedCount, expected] = subscriberCellStatsService.countAndDistinctByCellIds(cellIds)
    // alternative lazy streaming for real SMSC path: forEachMsisdn(cellIds, sink) parallel 16 * SELECT DISTINCT msisdn WHERE IN(500) -> sink -> SmsMessage

    // ---- Activity 4 Dedup ----
    // MsisdnDeduplicator.deduplicate(msisdns, capId) -> DedupResult[deduplicated, duplicatesRemoved]
    duplicatesRemoved = 0 (when cellIds distinct)
    distinct = expected // e.g., 5

    // ---- Activity 6 SMPP Submission ----
    isSmppConfigured = TurantConfig.smpp.host!=empty && systemId!=empty // SmppClient:54 + TurantConfig:300
    awaitingCredentials = !isSmppConfigured
    IF !isSmppConfigured:
      submitted=0; accepted=0; log Would submit
    ELSE:
      SmppClient.connect() // SmppClient.java:131 SMPPSession.connectAndBind(host,port,BIND_TRX,systemId,password,systemType,0x34,TON/NPI,enquireLink 30s,transaction 10s)
      // Build SmsMessage per msisdn
      msisdns = subscriberCellStatsService.collectMsisdns(cellIds) OR forEachMsisdn streaming batched 1000
      FOR each msisdn IN msisdns.distinct:
        msg = SmsMessage(messageId:UUID, alertId:capId, msisdn, content alert.headline 79 chars,
                         dataCoding SEVEN_BIT (GSM7) else UCS2, validityPeriod, priorityFlag 3, registeredDelivery 0x03)
        results += BatchFileSMSCService.submitOneByOne(msg) -> SmppClient.submitBatch(msgs, traceKey) -> SmppClient.submitSingle
          // SmppClient:256 session.submitShortMessage(src TON0/NPI0 dest TON1/NPI1, ESMClass 0, priority_flag, validity_period, registeredDelivery 3, DataCoding, messageBytes)
          // encodeMessageContent:339 validates empty|>160 GSM7|>70 UCS2 -> IllegalArgument
          // submit_sm_resp -> r.getMessageId() smscMessageId (SMPPSim "6") -> DlrListener.registerSubmission(smscMessageId, messageId, alertId, msisdn):281 -> outcome accepted|rejected (NegativeResponse 0x400 THROTTLED etc)
      submittedCount = results.size // 5
      acceptedCount = count(outcome==accepted) // 5
      batches = ceil(distinct/1000) // 1

    // ---- Activity 8,9,10 already applied per message ----

    // ---- Activity 7 EWS Feedback (non-blocking) ----
    report = ReportBuilder.build(alert, towerCount, matchedCount, expected, submitted, accepted, start, end)
    try EwsService.sendReport(report) // EwsService:27 -> EwsClientFactory:25 mode local? LocalEwsClient : RemoteEwsClient
    catch -> log non-blocking

    // ---- Activity 11 DLR ----
    // SmppClient:364 MessageReceiverListener on every session: onAcceptDeliverSm -> short_message (+ message_payload TLV) -> DlrListener.parseDeliveryReceipt:166 regex id:\S+ stat:\S+ -> DlrReceipt(smscMessageId, state DELIVRD|UNDELIV|EXPIRED..., err)
    //          handleReceipt:403 submissions.get(smscMessageId) -> noteReceipt(alertId, receipt) -> AlertReceiptStats
    // unmatched -> WARN Unmatched DLR
    DlrReporter.buildDeliveryReport(capId) -> {delivered=count(DELIVRD), expected, failed}

    // ---- 12-14 ----
    log Capacity appServers 1 scale horizontally, db Hikari max 30, parallel workers parallel, batchSize 5000, infrastructure TPS per TSP 1000

    store PipelineStatusStore.update(capId, status completed/halted, stage done, towerCount, matched, duplicatesRemoved, expected, submitted, accepted, awaiting)
    RETURN statusRecord
```

---

## 4. Optimized Geo-Targeted Subscriber Identification — `src/main/java/com/turant/subscriber/SubscriberCellStatsService.java:303` (KPI: 50k × 10cr <60s)

```pseudocode
// Migration 010: subscriber_cell_index (serving_cell_id int4 PK) + cell_subscriber_stats (cell_id PK, subscriber_count, unique) + cell_postings int4[] + turant_agg.cell_subscriber_agg (serving_cell_id PK, sub_count, distinct_count)
// Setup: ANALYZE, FK subscriber_dump.serving_cell_id -> sim_cell_towers.cell_id (migration 008)

SERVICE SubscriberCellStatsService(JdbcTemplate nullable, simulation.mode, statsTable=cell_subscriber_stats:120, aggTable=turant_agg.cell_subscriber_agg:96, dumpTable=subscriber_dump:129, parallelism 16:214)
  IF jdbc==null AND realMode (simulation!=enabled) -> throw REAL MODE no JdbcTemplate
  executor = FixedThreadPool(parallelism) if jdbc!=null

FUNCTION countAndDistinctByCellIds(cellIds: List<String>) -> [total, distinct]:
  IF jdbc==null && realMode -> throw else if sim -> return [0,0]
  IF cellIds empty -> return [0,0]
  // PRIMARY O(k) — aggregate table (migrations 010, KPI 38ms@50k PG)
  agg = aggregateOverAggTable(cellIds) //:421 chunk 2000: SELECT COALESCE(SUM(sub_count),0), SUM(distinct_count) FROM aggTable WHERE serving_cell_id IN (?,...)
                    // IF table missing -> return [-1,-1] fallback
  IF agg[0] > 0: log PRIMARY aggregate total/distinct; RETURN agg
  // SECONDARY parallel dump scan (post-H2 fallback)
  dump = parallelAggregateOverDump(cellIds) // chunk 500 *16 threads: SELECT COUNT(*), COUNT(DISTINCT msisdn) FROM dumpTable WHERE serving_cell_id IN (?) per chunk, sum
  IF dump[0] > 0: log SECONDARY parallel dump; RETURN dump
  // FALLBACK derived aggregate
  stats = aggregateOverStats(cellIds) // chunk 500: SELECT COALESCE(SUM(subscriber_count),0), SUM(unique_subscriber_count) FROM cell_subscriber_stats WHERE cell_id IN (...)
  IF stats[0] > 0: log FALLBACK; RETURN stats
  // NONE
  log SUBSCRIBER MATCH DIAGNOSTICS towerCellIds N, statsMatches 0, sampleTowerCellIds[10], sampleStatsCellIds[10], subscriberSum 0
  RETURN [0,0]

FUNCTION aggregateOverStats(cellIds chunk500): [total,distinct]
  total=distinct=0
  FOR chunk IN chunk(cellIds,500):
    sql = SELECT COALESCE(SUM(countCol),0), SUM(uniqueCol) FROM statsTable WHERE cellCol IN (?,?,...)
    row = jdbc.queryForMap(sql, chunk)
    total+=row.total; distinct+=row.dtotal
  RETURN [total,distinct]

FUNCTION aggregateOverAggTable(cellIds chunk2000): [total,distinct] // O(k) KPI
  similarly chunk 2000, SUM(sub_count)/SUM(distinct_count); on failure return [-1,-1]

FUNCTION parallelAggregateOverDump(cellIds chunk500):
  chunks = chunk(cellIds,500); threads = min(parallelism, chunks.size)
  IF threads<=1 -> sequential aggregateOverDumpChunk per chunk
  ELSE futures = executor.submit(aggregateOverDumpChunk) per chunk -> sum futures
FUNCTION aggregateOverDumpChunk(chunk):
  SELECT COUNT(*) c, COUNT(DISTINCT msisdn) d FROM dumpTable WHERE serving_cell_id IN (?,?,...)

FUNCTION forEachMsisdn(cellIds, Consumer<String> sink) -> streamed distinct:
  // Streams DISTINCT msisdn for real SMSC (submittedCount path) — batched 1000, bounded memory
  chunks 500, parallel 16 -> SELECT DISTINCT msisdn FROM dumpTable WHERE serving_cell_id IN (...) -> per row sink.accept(msisdn) -> AtomicLong count
  RETURN total streamed // pipeline uses this to create SmsMessage per msisdn, not just count

FUNCTION distinctMsisdnCount(cellIds): distinct
  aggDistinct = aggregateOverAggTable(cellIds)[1]; IF >0 RETURN it; ELSE RETURN parallelAggregateOverDump(cellIds)[1]
FUNCTION collectMsisdns(cellIds): Set<String> -> forEachMsisdn into ConcurrentHashMap.newKeySet

DIAGNOSTICS: runFirstCallDiagnostics once, probe SELECT COUNT(*), SUMs, sample 10 cell_ids random, logMatchDiagnostics probe 100 cells: SELECT COUNT(*) FROM statsTable WHERE cell_id IN (...), sample matches, null/blank count, fuzzy LIKE

// Current live benchmark (H2 synthetic 100k cells ~100M subs, .benchmark-subscriber-matching.md:1 historical PG 97M):
// Populate 100k via batch 2000 -> 2408ms -> 20k warmMed 304ms, 50k 743ms, 100k 2420ms in H2 (pass <60k)
// Production PG 50k warmMed 40ms (docs/benchmarks/PERFORMANCE_BENCHMARK_RESULTS.md:124 8 workers 15k msg/s, dedup 149k msg/s)
```

---

## 5. Tower Resolution — `src/main/java/com/turant/cellsite/TowerResolver.java:81` `PostGisTowerSource.java:42` `SimulatedTowerSource.java:30`

```pseudocode
TowerResolver(simulation.mode, tower.source-mode:postgis:59, PostGisTowerSource @ConditionalOnDatabaseConfigured, SimulatedTowerSource)
  REGISTER: PostGisTowerSource as 'postgis' always if DS available
  REGISTER: SimulatedTowerSource as 'simulated' ONLY IF simulation.mode==enabled (else never, guard REAL MODE)
  // Note: SimulatedTowerSource.java:30 annotation commented — bean always exists but TowerResolver never exposes it in real mode
  Guard realMode: IF simulation==disabled AND configured source not registered -> IllegalStateException
                 IF resolved source instanceof SimulatedTowerSource -> throw REAL MODE VIOLATION
                 Runtime IF source.name==simulated in realMode -> future exceptionally REAL MODE VIOLATION

FUNCTION TowerResolver.findTowersInZone(zone, options) -> CompletableFuture<TowerResolutionResult>
  budget = tower.match-time-budget-ms:69 5000, limit 100000:70
  source = registry[ tower.source-mode ]
  future = source.findTowersInZone(zone, options).orTimeout(budget)
  result.rawTotal = towers.size, result.duplicatesRemovedAtSource, perGeometryCounts

PostGisTowerSource.findTowersInZone(zone: GeoZone, options):
  sql = SELECT site_id AS id, cell_id, latitude, longitude, coverage_radius_m [or coverage_geom]
        FROM ${TOWER_TABLE:sim_cell_towers:60}
        WHERE ST_Within(geom, ST_Collect(ARRAY[ST_MakePolygon(...), ST_Buffer(circle)])) // postgis-jdbc 2023.1.0, JTS 1.19 SRID4326:68
        LIMIT ${TOWER_MATCH_LIMIT:100000}
  map rows -> CellTower(id, cellId, lat, lng, coverageRadiusM, coverageGeoJson) // CellTower.java
  RETURN TowerResolutionResult(towers, count, rawTotal, duplicatesRemoved 0, perGeometryCounts)

SimulatedTowerSource.findTowersInZone(zone):
  FOR each geometry in zone (polygon|circle):
    generate deterministic 5-50 towers within geometry spread 5km using Random(seed=capId hash)
    cellId = 404-XX-XXXX-XXXX indian format, lat/lng within bounds, coverageRadiusM 500
  RETURN result (IS_SIMULATED true)

CALLER AlertPipeline dedup by site_id: finalUnique = distinctBy(site_id), duplicatesRemovedPipeline = raw - final
```

---

## 6. SMPP / SMSC — `src/main/java/com/turant/smpp/SmppClient.java:42` jSMPP 3.0.1 `pom.xml:86` + `SimulatedSmppClient.java:28`

```pseudocode
SmppClient(@Component, always) fields: host ${SMPP_HOST:}, port 2775:${SMPP_PORT:2775}, systemId, password, systemType, bindMode transceiver:94, interfaceVersion 52:95, TON/NPI 0/0:96, srcAddr, dest TON1/NPI1:99, submitConcurrency 10:102, enquireLink 30s:104, registeredDelivery 3:106

isConfigured(): BOOLEAN = host!="" && systemId!=""
connect():
  IF !isConfigured -> return FailedFuture("SMPP credentials not configured")
  IF session!=null && session.isBound -> return already
  session = new SMPPSession()
  session.setMessageReceiverListener(createDlrMessageReceiverListener():364) // re-registered each connect
  BindParameter bind = BindParameter(BindType.BIND_TRX:147, systemId, password, systemType, TON0,NPI0, InterfaceVersion 0x34)
  session.connectAndBind(host,port,bind) // TCP + BIND_TRX
  session.setEnquireLinkTimer(enquireLinkPeriod 30000) // SmppClient:136
  session.setTransactionTimer(submitTimeout 60000)
  log "Connecting to SMSC host port" + "SMPP session bound successfully" (never password)

encodeMessageContent(content, SmsDataCoding SEVEN_BIT|UCS2): byte[]
  IF content empty -> throw IllegalArgument "SMS content must not be empty"
  IF SEVEN_BIT && len>160 -> throw; IF UCS2 && len>70 -> throw; else GSM7 bytes vs UCS2 bytes

submitSingle(SmsMessage{id, alertId, msisdn, content, dataCoding, validityPeriod Instant, priorityFlag byte 1|3, registeredDelivery 1}):
  bytes = encodeMessageContent(content, dataCoding) // SmsDataCoding.java
  // SmppClient:256
  SubmitSmResult r = session.submitShortMessage(
    serviceType "", src TON0 NPI0 srcAddr, dest TON1 NPI1 msisdn,
    ESMClass 0, (byte)priorityFlag:266, validityPeriod string 2609081247000000:268 (ValidityPeriod.java:248 absolute), 
    registeredDelivery:269 (byte)3, replace 0, DataCoding(alphabet), 0, bytes)
  smscMessageId = r.getMessageId() // "6" from SMPPSim, non-empty
  DlrListener.registerSubmission(smscMessageId, messageId, alertId, msisdn):281 // correlation for deliver_sm
  outcome = (r != null && status==OK) ? accepted : rejected // NegativeResponseException -> commandStatus e.g., 0x400 THROTTLED
  RETURN SubmissionResult(messageId, msisdn, outcome, smscMessageId, errorCode)

submitBatch(msgs,traceKey):
  executor = FixedThreadPool(16) // SmppClient:102
  futures = msgs.map(msg -> CompletableFuture.supplyAsync(() -> submitSingle(msg), executor))
  return CompletableFuture.allOf(futures) -> List<SubmissionResult> // BatchFileSMSCService: submitConcurrency 25 prod

SimulatedSmppClient @Component("simulatedSmppClient") @ConditionalOnProperty(simulation.mode=enabled):28
  isConfigured()=true always; connect()->completed; submitSingle 95% accepted SIM<uuid> latency 50-200ms
  // Never used when SmppClient.isConfigured() true in production (AlertPipeline chooses real)

SMPPSim Validation: docs/sms/SMPPSIM_VALIDATION.md:1 DEVELOPMENT/TEST ONLY
  Host 127.0.0.1:5555 systemId pavel password wpsd systemType SMPP BIND_TRX (haifzhan/SMPPSim 1.0)
  Evidence: Test-NetConnection True, TCP+bind 64ms, submit_sm_resp messageId 40, pipeline 5/5/5/5, DLR 5 correlated
  Production: TURANT_SMPP_HOST:50 blank pending C-DOT credentials
```

---

## 7. DLR Feedback — `src/main/java/com/turant/dlr/DlrListener.java:26` `DlrReporter.java`

```pseudocode
DlrListener fields: Map<smscMessageId, SubmissionInfo[alertId,msisdn,messageId]> submissions, Map<alertId, AlertReceiptStats> receipts

registerSubmission(smscMessageId, messageId, alertId, msisdn):
  submissions.put(smscMessageId, info)
  log DEBUG correlation registered

parseDeliveryReceipt(shortMessage String) -> DlrReceipt:
  // Example: "id:40 sub:001 dlvrd:001 submit date:2609071618 done date:2609071618 stat:DELIVRD err:000 Text:TURANT..."
  regex id:(\S+) stat:(\S+) err:(\S+)? -> smscMessageId=40, state=DELIVRD, errorCode=000, deliveredAt=now
  IF empty or no id -> null ignored
  IF stat empty -> UNKNOWN

handleReceipt(smscMessageId, shortMessage):
  info = submissions.get(smscMessageId)
  IF info == null -> WARN Unmatched DLR receipt smscMessageId=36 (not counted)
  ELSE receipt = parseDeliveryReceipt(shortMessage) -> noteReceipt(info.alertId, receipt)

noteReceipt(alertId, receipt):
  stats = receipts.computeIfAbsent(alertId, AlertReceiptStats)
  stats.received.add(receipt); stats.countsByState[receipt.state]++

createDlrMessageReceiverListener(): MessageReceiverListener // SmppClient:364
  onAcceptDeliverSm(DeliverSm deliverSm):
    bytes = deliverSm.getShortMessage() // + optionalParam message_payload TLV fallback 384
    text = new String(bytes, UTF-8)
    receipt = DlrListener.parseDeliveryReceipt(text):166
    DlrListener.handleReceipt(extractId(text), text) // handles DELIVRD, EXPIRED, UNDELIV, REJECTD, DELETED, ACCEPTD, ENROUTE, UNKNOWN extensible switch:403
    log DEBUG Received deliver_sm id:40 stat:DELIVRD -> INFO DLR received alertId live-alert-001

AlertPipeline DLR phase: DlrReporter.buildDeliveryReport(capId) -> {delivered=count(DELIVRD), expected=distinct, failed=UNDELIV+REJECTD, states}
  log DLR: cap test-pipeline-smpp-... delivered 5/5 firstState DELIVRD smscId 48
```

---

## 8. EWS Feedback — `src/main/java/com/turant/ews/` Activity 7

```pseudocode
EwsMode.java: LOCAL | REMOTE enum, invalid -> IllegalStateException
EwsProperties.java: @ConfigurationProperties(prefix=turant.ews) mode ${EWS_MODE:local:183} baseUrl ${EWS_BASE_URL:} localUrl ${EWS_LOCAL_URL:} apiKey ${EWS_API_KEY:} username/password path /ews/callback:61 method POST:66 connectTimeout 5s:78 readTimeout 15s:79 sslEnabled keystore/truststore // EwsProperties:103 validate() IF remote && baseUrl blank -> IllegalStateException fail-closed

EwsClient.java: interface send(EwsRequest{alertId,capIdentifier,payload:AlertReport})->EwsResponse{mode,status,referenceId}
                default sendReport(AlertReport) maps to EwsRequest

EwsClientFactory.java:25 getClient(): switch properties.mode {LOCAL -> localEwsClient, REMOTE -> remoteEwsClient, else throw}

LocalEwsClient.java:28 (DEVELOPMENT/TEST, clearly marked)
  RestClient SimpleClientHttpRequestFactory timeouts
  send(req):
    url = effectiveUrl() // priority: EWS_LOCAL_URL ?: http://localhost:${local.server.port or server.port}/api/v1/ews/local/receive:73
    IF url blank -> fallback in-memory: return {mode:local, status:accepted, referenceId:LOCAL-<uuid>, alertId}
    ELSE
      RestClient POST url JSON EwsRequest -> LocalEwsReceiveController -> 200 {mode:local, status:accepted, referenceId:LOCAL-..., alertId, payload}
      on I/O error (Connection refused) -> fallback in-memory WARN falling back
    logs alertId,url only (never secret)

RemoteEwsClient.java:26 (production, never hardcoded)
  RestClient(baseUrl, timeouts) // SimpleClientHttpRequestFactory:39
  send(req):
    IF baseUrl blank -> throw NOT_CONFIGURED
    headers: IF apiKey set -> header authHeaderName:${EWS_API_KEY:} with prefix "Bearer "; ELSE IF username/password -> Basic
    map method: POST -> POST, PUT -> PUT, GET -> GET to baseUrl+path
    try response = restClient.post().uri(path).headers(...).body(req).retrieve()
      2xx -> SUCCESS 200 {mode:remote, status:accepted, referenceId:extractId}
      400/404 -> INVALID_REQUEST 400
      401/403 -> AUTHENTICATION_FAILURE 401/403
      409/429 -> REMOTE_REJECTED 409
      5xx -> SERVER_ERROR 5xx
    catch ResourceAccessException timeout -> TIMEOUT 504; connect -> CONNECTION_FAILURE 502
         HttpClientErrorException -> map as above; HttpServerErrorException -> SERVER_ERROR
    extract referenceId from JSON, never log Authorization/apiKey

LocalEwsReceiveController.java: POST /api/v1/ews/local/receive (controlled local EWS server)
  validates alertId required -> 400 else logs, stores LocalEwsStore.record(request, response), returns accepted or simulateFailure ?simulateFailure=401/500 via query param or X-EWS-FAIL header
  GET /last-received -> {receivedCount, lastReceivedAt, request, response}
  GET /received-count, /history, POST /clear

EwsService.java:27
  sendReport(AlertReport report):
    client = factory.getClient(); // local or remote by mode
    try client.sendReport(report) catch EwsException -> log non-blocking
  handleFeedback(EwsFeedback{alertId,referenceId,status,deliveredCount}) // POST /api/v1/ews/feedback EwsFeedbackController:115
    idempotent by alertId::referenceId, persist DB + memory, update PipelineStatusStore correlation

AlertPipeline EWS phase: after completed status stored, try ewsService.sendReport(report) catch never throws, never blocks; legacy EwsCallback fallback
Production: application-production.properties:60 EWS_MODE=remote, EWS_BASE_URL:https://<provided-by-C-DOT> blank pending contract, EWS_SSL_ENABLED true requires mTLS certs /etc/turant/certs
```

---

## 9. Security (10 Layers) — `src/main/java/com/turant/security/` `docs/security/SECURITY_COMPLETE.md:1`

```pseudocode
Layer1 TLS: server.ssl.enabled ${SSL_ENABLED:false dev, true prod:87} keyStore /etc/turant/certs/server.p12:88 protocol TLS:92 enabled TLSv1.2,TLSv1.3:93, HSTS via WebConfig:56 securityHeadersFilter, cookie httpOnly+secure:101
Layer2 mTLS: MtlsIdentityService:27 extracts jakarta.servlet.request.X509Certificate || javax fallback, checkValidity(), CN extraction 72-83, isMtlsRequired:93 client-auth==need; MtlsAuthFilter:25 Ordered+11 enforces on POST /pipeline/*:39 IF mtlsRequired && cert==null -> 401 client cert required:50; anti-spoof ignore X-CLIENT-ID:62; Audit cert_subject
Layer3 CAP Sig: CapSignatureService:21 loadPublicKey PEM TSP_PUBLIC_KEY_PEM:110, verify:46 canonicalize strip <code>signature</code>:104, SHA256withRSA/ECDSA, enum MISSING/MALFORMED/INVALID/DISABLED; SecurityService:121 rejects if INVALID when key configured else DISABLED dev warns:36
Layer4 AuthZ: AuthorizationService:25 isAllowed(operation) switch SUBMIT_CAP,GET_STATUS,GET_TOWERS,GET_REPORT,DELETE_ALERT,ADMIN default false, HEALTH true:21; SecurityService:97 audits AUTHORIZATION_DENIED/ALLOWED, roles from ClientCredentialsService rolesFor split CSV
Layer5 CAP XXE: CapParser:34 disallow-doctype true:41 external-general-entities false:44 load-external-dtd false:48 FEATURE_SECURE_PROCESSING true:51 XInclude false:53 ACCESS_EXTERNAL_DTD "":60 entityExpansionLimit 10000:62 totalEntitySizeLimit 50000:63 + normalizeAlert requires identifier etc + polygon >=4 closed
Layer6 Replay: ReplayProtectionService:30 INSERT INTO cap_replay (cap_identifier,sender,hash,ip,clientId) -> duplicate PK -> 409 REPLAY_DETECTED:37, PK (identifier,sender):10 cap_replay:012
Layer7 Credentials: ClientCredentialsService:22 hash SHA256 hex:46 not plaintext, cache+DB findByApiKey:44, enabled/revoked/expires check:50, ApiKeyAuthFilter:27 Ordered+10 checks X-API-KEY/X-EWS-API-KEY/Authorization Bearer:137 constantTimeEquals:159 DB fallback:108
Layer8 IP: IpRestrictionService:18 isInCidr:50 InetAddress mask, global allowlist + per-client allowed_ips:32, enabled turant.security.ip-enforce:false:24 -> enable prod
Layer9 RateLimit: RateLimitService:28 token-bucket per clientId:endpoint:30 window 60s:34 ConcurrentHashMap:26 (single instance; Redis distributed pending for APP_SERVERS>1), SecurityService:113 429 RATE_LIMIT_EXCEEDED
Layer10 Audit: AuditService:49 hash chain previous_hash -> SHA256(canonical) -> current_hash:66 fetchPreviousHash seq DESC, verifyChain:92, REVOKE UPDATE,DELETE on security_audit:9 migration 014
Additional: WebConfig CORS origins * dev prod must override, Debug endpoints TurantConfig.DebugConfig endpointsEnabled false, secret non-logging verified SmppClient host/port only, RemoteEwsClient alertId/path/status only
```

---

## 10. Parallel & Capacity — `src/main/java/com/turant/parallel/` `src/main/resources/application.properties:203`

```pseudocode
turant.parallel.execution-mode threads:204, workerCount 16:205, submitBatchSize 5000:206
turant.infra.app-servers 4:208, dbPoolMax 30:209, smsc.tps-per-tsp 1000:210 (Activities 12-13 external)
turant.prefetch.storage-dir ./data/prefetch:212, refreshMs 43200000:213
turant.vlr.parallelism 16:215, chunkMb 64:216

ParallelOrchestrator orchestrates alert pipeline AlertSubmitSummary parallel batches:
  splitBatches(msisdns, workers, batchSize 500) -> List<List<String>> batches = ceil(msisdns.size/batchSize) distributed round-robin
  // benchmark: docs/benchmarks/PERFORMANCE_BENCHMARK_RESULTS.md:122 8 workers 15,924 msg/s linear 100% efficiency, dedup 149k msg/s
```

---

## 11. KPI Benchmarking (Historical Evidence)

```pseudocode
// Historical prod-like benchmark .benchmark-subscriber-matching.md:1 (PostgreSQL 16, 97M rows, cell-indexed, 3 iters)
FOR tier IN [100, 1000, 5000, 10000, 25000, 50000]:
  coldMs = first query (JIT) ; warmMed = median of 3; warmMean = avg
  100 cells -> 206k rows cold 12ms warmMed 2ms
  50000 cells -> 97,457,009 rows cold 38ms warmMed 40ms (KPI 60s pass, 1500x margin)
Multi-polygon A 25k + B 37.5k union 50k rows 97M <= sum 121M true dedup 24M

// Live H2 synthetic 100k cells ~100M subs KpiOptimizedSubscriberBenchmarkTest:1 (2026-09-21)
// Populate batch 2000 -> 2408ms; 20k warmMed 304ms, 50k 743ms, 100k 2420ms (H2 ~18x slower than PG but still <60s, all PASS)
// Current audit: mvn clean test 248/248 42s, mvn clean package JAR 43MB, SMPPSim 127.0.0.1:5555 pipeline 5/5/5/5 DLR 5
```

---

**File History:** Initial creation for `TURANT-RELEASE-v0.1.0` handover package. Covers source `bb08b3d` `docs/handover/FINAL_INTEGRATION_VALIDATION.md:15`, `docs/sms/SMPPSIM_VALIDATION.md:1`, `docs/ews/EWS_INTEGRATION.md:1`, `docs/security/SECURITY_COMPLETE.md:1`, `docs/benchmarks/PERFORMANCE_BENCHMARK_RESULTS.md:1`. Historical reports `docs/reports/` preserved as archives.
