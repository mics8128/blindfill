package io.github.mics8128.blindfill;

import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.content.pm.SigningInfo;
import android.os.SystemClock;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;
import org.json.JSONObject;

/**
 * One pending request armed by the host (`blindfill android fill|passkey`). Holds no vault data:
 * only a one-time token, the loopback port the host listens on (via `adb reverse`) and display
 * labels. Lives in memory; a killed process simply fails closed.
 */
final class Arm {
    final String token;
    final int port;
    final String mode; // "password" | "password-new" | "passkey" | "passkey-create"
    final String item;
    final String user;
    final String rpId;
    final long expires; // elapsedRealtime

    private static Arm current;

    private Arm(String token, int port, String mode, String item, String user, String rpId, long ttlMs) {
        this.token = token;
        this.port = port;
        this.mode = mode;
        this.item = item;
        this.user = user;
        this.rpId = rpId;
        this.expires = SystemClock.elapsedRealtime() + ttlMs;
    }

    static synchronized void set(String token, int port, String mode, String item, String user, String rpId, long ttlMs) {
        current = token == null || token.isEmpty() ? null : new Arm(token, port, mode, item, user, rpId, ttlMs);
    }

    /** Look without consuming (credential selector listing). */
    static synchronized Arm peek(String mode) {
        if (current == null || SystemClock.elapsedRealtime() > current.expires) current = null;
        return current != null && current.mode.equals(mode) ? current : null;
    }

    /** Consume: an armed request answers at most one fill. */
    static synchronized Arm take(String mode) {
        Arm a = peek(mode);
        current = null;
        return a;
    }

    /** One JSON line to the host and one back. Loopback only. */
    JSONObject call(JSONObject req) throws Exception {
        req.put("token", token);
        try (Socket s = new Socket(InetAddress.getLoopbackAddress(), port)) {
            s.setSoTimeout(10_000);
            OutputStream out = s.getOutputStream();
            out.write((req.toString() + "\n").getBytes(StandardCharsets.UTF_8));
            out.flush();
            BufferedReader in = new BufferedReader(new InputStreamReader(s.getInputStream(), StandardCharsets.UTF_8));
            String line = in.readLine();
            return line == null ? new JSONObject().put("ok", false) : new JSONObject(line);
        }
    }

    /** SHA-256 of the single current signing certificate, hex; null when it cannot be pinned. */
    static byte[] signerDigest(SigningInfo si) throws Exception {
        if (si == null || si.hasMultipleSigners()) return null;
        Signature[] s = si.getApkContentsSigners();
        if (s == null || s.length != 1) return null;
        return MessageDigest.getInstance("SHA-256").digest(s[0].toByteArray());
    }

    static byte[] signerDigest(PackageManager pm, String pkg) throws Exception {
        return signerDigest(pm.getPackageInfo(pkg, PackageManager.PackageInfoFlags.of(PackageManager.GET_SIGNING_CERTIFICATES)).signingInfo);
    }

    static String hex(byte[] b) {
        if (b == null) return null;
        StringBuilder sb = new StringBuilder();
        for (byte x : b) sb.append(String.format("%02X", x));
        return sb.toString();
    }

    static String b64url(byte[] b) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(b);
    }

    static String unb64(String s) {
        return s == null ? "" : new String(Base64.getUrlDecoder().decode(s), StandardCharsets.UTF_8);
    }
}
