package com.turant.smsc;

import com.turant.smpp.SmppClient;
import com.turant.types.sms.SmsMessage;
import com.turant.types.sms.SubmissionResult;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.nio.file.*;
import java.util.*;
import java.util.concurrent.CompletableFuture;

/**
 * Activity 6: High-Performance SMSC Integration — one-by-one + fragmented file/batch
 * Supports both direct SMPP submit_sm and file-based fragmented processing for TSPs
 * that accept batch files (e.g., 10k per file).
 */
@Service
public class BatchFileSMSCService {

    private static final Logger log = LoggerFactory.getLogger(BatchFileSMSCService.class);
    private final SmppClient smpp;
    private final Path batchDir;
    private final int fileBatchSize;

    public BatchFileSMSCService(SmppClient smpp,
                                @Value("${turant.smsc.batch-dir:./data/smsc}") String batchDir,
                                @Value("${turant.smsc.file-batch-size:10000}") int fileBatchSize) {
        this.smpp = smpp;
        this.batchDir = Path.of(batchDir);
        this.fileBatchSize = fileBatchSize;
        try{ Files.createDirectories(this.batchDir);}catch(Exception e){ log.warn("batch dir",e); }
    }

    public enum SubmitMode { ONE_BY_ONE, BATCH_FILE }

    /** One-by-one via SMPP (Activity 6a) */
    public CompletableFuture<List<SubmissionResult>> submitOneByOne(List<SmsMessage> msgs, String traceKey){
        return smpp.submitBatch(msgs, traceKey);
    }

    /** Fragmented file/batch (Activity 6b) — write per-TSP files then submit */
    public CompletableFuture<List<SubmissionResult>> submitBatchedFiles(List<SmsMessage> msgs, String traceKey, SubmitMode mode){
        if (mode==SubmitMode.ONE_BY_ONE) return submitOneByOne(msgs, traceKey);
        // Fragment into files of fileBatchSize (10k) per TSP/operator
        List<CompletableFuture<List<SubmissionResult>>> futures=new ArrayList<>();
        for (int i=0;i<msgs.size();i+=fileBatchSize){
                List<SmsMessage> chunk=msgs.subList(i, Math.min(i+fileBatchSize, msgs.size()));
                Path file=batchDir.resolve(String.format("%s_part%d.txt", traceKey, i/fileBatchSize));
                try{ Files.write(file, chunk.stream().map(m->m.msisdn()+","+m.content()).toList()); log.info("Wrote batch file {} size={}", file, chunk.size()); }catch(Exception ex){ log.error("batch file write",ex); }
                futures.add(smpp.submitBatch(chunk, traceKey+"-file"+i));
            }
        return CompletableFuture.allOf(futures.toArray(new CompletableFuture[0])).thenApply(v->{
            List<SubmissionResult> all=new ArrayList<>();
            for (var f: futures) all.addAll(f.join());
            log.info("Batched files done trace={} total={} mode={}", traceKey, all.size(), mode);
            return all;
        });
    }
}
