package com.turant.tools;

import org.postgresql.PGConnection;

import java.io.BufferedOutputStream;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;

/**
 * Zero-copy MSISDN export CLI: stages a cell-ID list in a TEMP table and
 * streams {@code COPY (SELECT DISTINCT msisdn ...) TO STDOUT} straight to a
 * CSV file. The JVM never aggregates subscriber rows — PostgreSQL does the
 * DISTINCT and the CopyManager pipes bytes to disk.
 *
 * <p>Usage:
 * <pre>
 *   java -cp &lt;classes+deps&gt; com.turant.tools.MsisdnExportCli \
 *     --cells cells.txt --out msisdns.csv [--limit 1000000]
 * </pre>
 * {@code cells.txt}: one {@code serving_cell_id} per line (blank lines ignored).
 * Connection via {@code DATABASE_URL}, {@code SPRING_DATASOURCE_USERNAME},
 * {@code SPRING_DATASOURCE_PASSWORD} (same variables as the backend).
 */
public final class MsisdnExportCli {

    private MsisdnExportCli() {
    }

    public static void main(String[] args) throws Exception {
        String cellsFile = arg(args, "--cells");
        String outFile = arg(args, "--out");
        long limit = Long.parseLong(arg(args, "--limit", "1000000"));
        if (cellsFile == null || outFile == null || limit < 1) {
            System.err.println("Usage: MsisdnExportCli --cells <file> --out <file> [--limit N]");
            System.exit(2);
        }
        List<String> cells = new ArrayList<>();
        for (String line : Files.readAllLines(Path.of(cellsFile))) {
            String id = line == null ? "" : line.trim();
            if (!id.isEmpty()) {
                cells.add(id);
            }
        }
        if (cells.isEmpty()) {
            System.err.println("No cell IDs in " + cellsFile);
            System.exit(2);
        }
        String url = env("DATABASE_URL", "jdbc:postgresql://localhost:5432/turant");
        String user = env("SPRING_DATASOURCE_USERNAME", "turant");
        String pass = env("SPRING_DATASOURCE_PASSWORD", "turant_dev_password");

        long t0 = System.currentTimeMillis();
        long rows;
        try (Connection con = DriverManager.getConnection(url, user, pass)) {
            con.setAutoCommit(true);
            try (Statement st = con.createStatement()) {
                st.execute("CREATE TEMP TABLE target_towers(cell_id text) ON COMMIT PRESERVE ROWS");
            }
            try (PreparedStatement ps = con.prepareStatement(
                    "INSERT INTO target_towers(cell_id) SELECT * FROM unnest(?::text[])")) {
                ps.setArray(1, con.createArrayOf("text", cells.toArray()));
                ps.executeUpdate();
            }
            try (Statement st = con.createStatement()) {
                st.execute("ANALYZE target_towers");
            }
            String copySql = "COPY (SELECT DISTINCT msisdn FROM subscriber_dump "
                    + "WHERE serving_cell_id IN (SELECT cell_id FROM target_towers) "
                    + "AND msisdn IS NOT NULL LIMIT " + limit + ") "
                    + "TO STDOUT (FORMAT csv, HEADER)";
            PGConnection pg = con.unwrap(PGConnection.class);
            try (OutputStream out = new BufferedOutputStream(
                    new FileOutputStream(outFile), 1 << 20)) {
                rows = pg.getCopyAPI().copyOut(copySql, out);
            }
            try (Statement st = con.createStatement()) {
                st.execute("DROP TABLE IF EXISTS target_towers");
            }
        }
        long ms = System.currentTimeMillis() - t0;
        // COPY returns data rows only (header excluded from the count).
        System.out.println("EXPORT cells=" + cells.size() + " rows=" + rows
                + " file=" + outFile + " elapsedMs=" + ms
                + " rate=" + (ms == 0 ? rows : (rows * 1000 / ms)) + "/s");
    }

    private static String arg(String[] args, String name) {
        return arg(args, name, null);
    }

    private static String arg(String[] args, String name, String def) {
        for (int i = 0; i + 1 < args.length; i++) {
            if (name.equals(args[i])) {
                return args[i + 1];
            }
        }
        return def;
    }

    private static String env(String name, String def) {
        String v = System.getenv(name);
        return (v == null || v.isBlank()) ? def : v;
    }
}
