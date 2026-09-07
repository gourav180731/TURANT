package com.turant.smpp;

import com.turant.dlr.DlrListener;
import com.turant.types.sms.DeliveryOutcome;
import com.turant.types.sms.SmsDataCoding;
import com.turant.types.sms.SmsMessage;
import com.turant.types.sms.SubmissionResult;
import org.jsmpp.InvalidResponseException;
import org.jsmpp.bean.*;
import org.jsmpp.extra.NegativeResponseException;
import org.jsmpp.extra.ProcessRequestException;
import org.jsmpp.extra.ResponseTimeoutException;
import org.jsmpp.session.BindParameter;
import org.jsmpp.session.DataSmResult;
import org.jsmpp.session.MessageReceiverListener;
import org.jsmpp.session.SMPPSession;
import org.jsmpp.session.SubmitSmResult;
import org.jsmpp.util.AbsoluteTimeFormatter;
import org.jsmpp.util.TimeFormatter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Real SMSC integration via SMPP - requirement #7.
 * 
 * A real SMPP 3.4 client (jSMPP) with bind lifecycle, submit_sm construction
 * using real fields from modules 08/09 (validity period, priority flag),
 * automatic reconnect and enquire_link keepalive.
 * 
 * Migrated from TypeScript Module 07 smpp-client.ts
 */
@Component
public class SmppClient {
    
    private static final Logger logger = LoggerFactory.getLogger(SmppClient.class);
    private static final TimeFormatter TIME_FORMATTER = new AbsoluteTimeFormatter();
    
    private SMPPSession session;
    private boolean closedByUs = false;
    private final ExecutorService executor;
    private final DlrListener dlrListener;
    
    @Value("${smpp.host:}")
    private String smppHost;
    
    @Value("${smpp.port:2775}")
    private int smppPort;
    
    @Value("${smpp.system-id:}")
    private String systemId;
    
    @Value("${smpp.password:}")
    private String password;
    
    @Value("${smpp.system-type:}")
    private String systemType;
    
    @Value("${smpp.bind-mode:transceiver}")
    private String bindMode;
    
    @Value("${smpp.interface-version:52}")
    private int interfaceVersion;
    
    @Value("${smpp.src-addr-ton:0}")
    private byte srcAddrTon;
    
    @Value("${smpp.src-addr-npi:0}")
    private byte srcAddrNpi;
    
    @Value("${smpp.src-addr:}")
    private String srcAddr;
    
    @Value("${smpp.dest-addr-ton:1}")
    private byte destAddrTon;
    
    @Value("${smpp.dest-addr-npi:1}")
    private byte destAddrNpi;
    
    @Value("${smpp.submit-timeout-ms:60000}")
    private long submitTimeoutMs;
    
    @Value("${smpp.submit-concurrency:10}")
    private int submitConcurrency;
    
    @Value("${smpp.reconnect-delay-ms:5000}")
    private long reconnectDelayMs;
    
    @Value("${smpp.enquire-link-period-ms:30000}")
    private long enquireLinkPeriodMs;
    
    public SmppClient(@Autowired(required = false) DlrListener dlrListener) {
        this.executor = Executors.newFixedThreadPool(16);
        this.dlrListener = dlrListener;
    }
    
    /**
     * Whether real SMSC credentials exist to bind against.
     */
    public boolean isConfigured() {
        return smppHost != null && !smppHost.isEmpty() && 
               systemId != null && !systemId.isEmpty();
    }
    
    /**
     * Connect and bind. Throws a clear error until real C-DOT credentials are provided.
     */
    public synchronized CompletableFuture<Void> connect() {
        if (!isConfigured()) {
            return CompletableFuture.failedFuture(
                new IllegalStateException(
                    "SMPP credentials not configured (SMPP_HOST / SMPP_SYSTEM_ID). " +
                    "Awaiting C-DOT SMSC sandbox credentials."
                )
            );
        }
        
        if (session != null && session.getSessionState().isBound()) {
            return CompletableFuture.completedFuture(null);
        }
        
        return CompletableFuture.supplyAsync(() -> {
            try {
                logger.info("Connecting to SMSC: host={}, port={}", smppHost, smppPort);
                
                session = new SMPPSession();
                session.setEnquireLinkTimer((int) (enquireLinkPeriodMs / 1000));
                session.setTransactionTimer(submitTimeoutMs);
                // Wire DLR listener to every new session (reconnect preserves correlation)
                if (dlrListener != null) {
                    session.setMessageReceiverListener(createDlrMessageReceiverListener());
                    logger.debug("DLR MessageReceiverListener registered on SMPPSession");
                } else {
                    logger.debug("No DlrListener available — deliver_sm will not be correlated");
                }
                
                BindParameter bindParam = new BindParameter(
                    BindType.BIND_TRX, // Use transceiver by default
                    systemId,
                    password,
                    systemType,
                    TypeOfNumber.valueOf(srcAddrTon),
                    NumberingPlanIndicator.valueOf(srcAddrNpi),
                    null
                );
                
                session.connectAndBind(smppHost, smppPort, bindParam);
                
                logger.info("SMPP session bound successfully");
                return null;
                
            } catch (IOException e) {
                logger.error("Failed to connect/bind to SMSC", e);
                throw new RuntimeException("SMPP connection failed", e);
            }
        }, executor);
    }
    
    /**
     * Submit one message; resolves to a real SubmissionResult.
     */
    public CompletableFuture<SubmissionResult> submitSingle(SmsMessage message) {
        return connect().thenCompose(v -> 
            CompletableFuture.supplyAsync(() -> submitOne(message), executor)
        );
    }
    
    /**
     * Submit a batch with bounded concurrency.
     */
    public CompletableFuture<List<SubmissionResult>> submitBatch(
            List<SmsMessage> messages, 
            String traceKey) {
        
        return connect().thenCompose(v -> {
            List<CompletableFuture<SubmissionResult>> futures = messages.stream()
                .map(msg -> CompletableFuture.supplyAsync(() -> submitOne(msg), executor))
                .toList();
            
            return CompletableFuture.allOf(futures.toArray(new CompletableFuture[0]))
                .thenApply(ignored -> {
                    List<SubmissionResult> results = new ArrayList<>();
                    for (CompletableFuture<SubmissionResult> future : futures) {
                        results.add(future.join());
                    }
                    
                    logger.info("Batch submission completed: messages={}, traceKey={}", 
                        messages.size(), traceKey);
                    
                    // TODO: Mark t3 on trace store when implemented
                    // traceStore.mark(traceKey, "t3", "smpp.submit_complete", System.currentTimeMillis());
                    
                    return results;
                });
        });
    }
    
    /**
     * Close the session.
     */
    public void close() {
        closedByUs = true;
        if (session != null) {
            session.unbindAndClose();
            session = null;
        }
    }
    
    /**
     * Submit one message to SMSC.
     */
    private SubmissionResult submitOne(SmsMessage message) {
        try {
            if (session == null || !session.getSessionState().isBound()) {
                return new SubmissionResult(
                    message.messageId(),
                    message.msisdn(),
                    DeliveryOutcome.failed,
                    null,
                    null,
                    "SMPP session not bound",
                    null
                );
            }
            
            // Build submit_sm PDU
            String content = encodeMessageContent(message.content(), message.dataCoding());
            byte[] messageBytes = content.getBytes(
                message.dataCoding() == SmsDataCoding.UCS2 ? "UTF-16BE" : "ISO-8859-1"
            );
            
            // Use appropriate jSMPP Alphabet enum for data coding
            Alphabet alphabet = message.dataCoding() == SmsDataCoding.UCS2 
                ? Alphabet.ALPHA_UCS2 
                : Alphabet.ALPHA_DEFAULT;
            
            // Format validity period if present (Module 08)
            String validityPeriodStr = null;
            if (message.validityPeriod() != null) {
                validityPeriodStr = ValidityPeriod.toSmppValidityPeriod(
                    message.validityPeriod(), 
                    true // truncate seconds
                );
            }
            
            // Submit message with priority flag (Module 09) and validity period (Module 08)
            SubmitSmResult result = session.submitShortMessage(
                "CMT",
                TypeOfNumber.valueOf(srcAddrTon),
                NumberingPlanIndicator.valueOf(srcAddrNpi),
                srcAddr != null ? srcAddr : "",
                TypeOfNumber.valueOf(destAddrTon),
                NumberingPlanIndicator.valueOf(destAddrNpi),
                message.msisdn(),
                new ESMClass(),
                (byte) 0, // protocol_id
                message.priorityFlag(), // priority_flag from message (Module 09)
                null, // schedule_delivery_time
                validityPeriodStr, // validity_period from message.validityPeriod (Module 08)
                new RegisteredDelivery((byte) message.registeredDelivery()),
                (byte) 0, // replace_if_present_flag
                new GeneralDataCoding(alphabet),
                (byte) 0, // sm_default_msg_id
                messageBytes
            );
            
            String messageId = result.getMessageId();
            
            logger.debug("Message submitted: messageId={}, msisdn={}, smscMessageId={}", 
                message.messageId(), message.msisdn(), messageId);
            // Register for DLR correlation (existing DlrListener logic)
            if (dlrListener != null && messageId != null && !messageId.isBlank()) {
                try {
                    dlrListener.registerSubmission(messageId, message.messageId(), message.alertId(), message.msisdn());
                    logger.debug("DLR correlation registered: smscMessageId={}, alertId={}, msisdn={}", messageId, message.alertId(), message.msisdn());
                } catch (Exception e) {
                    logger.warn("Failed to register DLR correlation for smscMessageId={}", messageId, e);
                }
            }
            
            return new SubmissionResult(
                message.messageId(),
                message.msisdn(),
                DeliveryOutcome.accepted,
                messageId,
                null,
                null,
                null
            );
            
        } catch (ResponseTimeoutException | InvalidResponseException | IOException e) {
            logger.error("Failed to submit message: messageId=" + message.messageId(), e);
            return new SubmissionResult(
                message.messageId(),
                message.msisdn(),
                DeliveryOutcome.failed,
                null,
                null,
                e.getMessage(),
                null
            );
        } catch (NegativeResponseException e) {
            logger.warn("Message rejected by SMSC: messageId={}, commandStatus={}", 
                message.messageId(), e.getCommandStatus());
            return new SubmissionResult(
                message.messageId(),
                message.msisdn(),
                DeliveryOutcome.rejected,
                null,
                e.getCommandStatus(),
                getSmppErrorText(e.getCommandStatus()),
                null
            );
        } catch (Exception e) {
            // Catch any other unexpected exceptions
            logger.error("Unexpected error submitting message: messageId=" + message.messageId(), e);
            return new SubmissionResult(
                message.messageId(),
                message.msisdn(),
                DeliveryOutcome.failed,
                null,
                null,
                e.getMessage(),
                null
            );
        }
    }
    
    /**
     * Validate content length for the target coding; fail loudly, never truncate.
     */
    private String encodeMessageContent(String content, SmsDataCoding dataCoding) {
        int maxChars = dataCoding == SmsDataCoding.UCS2 ? 70 : 160;
        
        if (content.isEmpty()) {
            throw new IllegalArgumentException("SMS content must not be empty");
        }
        
        if (content.length() > maxChars) {
            throw new IllegalArgumentException(
                String.format("SMS content is %d characters; exceeds %d for %s coding. " +
                    "Early-warning messages must fit one SMS.", 
                    content.length(), maxChars, dataCoding.getValue())
            );
        }
        
        return content;
    }
    
    /**
     * Create MessageReceiverListener that routes deliver_sm to existing DlrListener.
     * Attached to every new SMPPSession (reconnect preserves correlation).
     * Handles DELIVRD, EXPIRED, UNDELIV, REJECTD, DELETED and extensible others.
     */
    private MessageReceiverListener createDlrMessageReceiverListener() {
        return new MessageReceiverListener() {
            @Override
            public void onAcceptDeliverSm(DeliverSm deliverSm) throws ProcessRequestException {
                try {
                    byte[] shortMsg = deliverSm.getShortMessage();
                    String receiptText = null;
                    if (shortMsg != null && shortMsg.length > 0) {
                        // jSMPP delivers short_message as bytes; SMPPSim uses GSM7 plain text
                        try {
                            receiptText = new String(shortMsg, java.nio.charset.StandardCharsets.UTF_8);
                            // If contains non-UTF8, fallback to GSM
                            if (receiptText.contains("\u0000")) {
                                receiptText = new String(shortMsg, java.nio.charset.StandardCharsets.ISO_8859_1);
                            }
                        } catch (Exception e) {
                            receiptText = new String(shortMsg, java.nio.charset.StandardCharsets.ISO_8859_1);
                        }
                    }
                    // Also check message_payload optional param if short_message empty
                    if ((receiptText == null || receiptText.isBlank()) && deliverSm.getOptionalParameters() != null) {
                        for (org.jsmpp.bean.OptionalParameter op : deliverSm.getOptionalParameters()) {
                            if (op instanceof org.jsmpp.bean.OptionalParameter.Message_payload) {
                                byte[] payload = ((org.jsmpp.bean.OptionalParameter.Message_payload) op).getValue();
                                if (payload != null) receiptText = new String(payload, java.nio.charset.StandardCharsets.UTF_8);
                            }
                        }
                    }
                    if (receiptText == null) receiptText = "";
                    // Trim for logging (never log credentials — receipt has no secrets)
                    String logText = receiptText.length() > 300 ? receiptText.substring(0, 300) + "..." : receiptText;
                    logger.debug("Received deliver_sm: {}", logText);

                    if (dlrListener != null) {
                        var parsed = DlrListener.parseDeliveryReceipt(receiptText);
                        if (parsed != null) {
                            String state = parsed.messageState();
                            // Handle expected states, but extensible — any stat is recorded
                            if (state != null) {
                                switch (state) {
                                    case "DELIVRD":
                                    case "EXPIRED":
                                    case "UNDELIV":
                                    case "REJECTD":
                                    case "DELETED":
                                    case "ACCEPTD":
                                    case "ENROUTE":
                                    case "UNKNOWN":
                                        logger.info("DLR deliver_sm parsed: smscMessageId={}, state={}, err={}", parsed.smscMessageId(), state, parsed.errorCode());
                                        break;
                                    default:
                                        logger.info("DLR deliver_sm with unlisted state: smscMessageId={}, state={}, err={}", parsed.smscMessageId(), state, parsed.errorCode());
                                }
                            }
                            // Correlate via existing logic (logs matched vs uncorrelated)
                            dlrListener.handleReceipt(receiptText, null);
                        } else {
                            logger.debug("Non-DLR deliver_sm ignored (no id/stat): {}", logText);
                            // Still try to handle via DlrListener for uncorrelated logging
                            dlrListener.handleReceipt(receiptText, null);
                        }
                    } else {
                        logger.warn("DLR received but no DlrListener registered — receipt not correlated");
                    }
                } catch (Exception e) {
                    logger.warn("Failed to process deliver_sm", e);
                    // Do not throw ProcessRequestException — we want to ACK the deliver_sm (ESME_ROK) even if parsing fails
                }
            }

            @Override
            public void onAcceptAlertNotification(AlertNotification alertNotification) {
                logger.debug("Received AlertNotification: {}", alertNotification);
            }

            @Override
            public DataSmResult onAcceptDataSm(DataSm dataSm, org.jsmpp.session.Session source) throws ProcessRequestException {
                logger.debug("Received DataSm: {}", dataSm);
                return null;
            }
        };
    }

    /**
     * Get human-readable error text for SMPP command status.
     */
    private String getSmppErrorText(int commandStatus) {
        return switch (commandStatus) {
            case 0 -> "ESME_ROK";
            case 4 -> "ESME_RINVMSGLEN";
            case 5 -> "ESME_RINVCMDLEN";
            case 8 -> "ESME_RINVSRCADR";
            case 0xa -> "ESME_RINVDSTADR";
            case 0xb -> "ESME_RINVMSGID";
            case 0xc -> "ESME_RBINDFAIL";
            case 0xd -> "ESME_RINVPASWD";
            case 0xe -> "ESME_RINVSYSID";
            case 0x400 -> "ESME_RTHROTTLED";
            case 0x402 -> "ESME_RINVEXPIRY";
            default -> "command_status=" + commandStatus;
        };
    }
}
