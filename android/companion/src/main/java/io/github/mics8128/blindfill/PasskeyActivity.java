package io.github.mics8128.blindfill;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.GetPublicKeyCredentialOption;
import androidx.credentials.PublicKeyCredential;
import androidx.credentials.CredentialOption;
import androidx.credentials.exceptions.GetCredentialUnknownException;
import androidx.credentials.provider.CallingAppInfo;
import androidx.credentials.provider.PendingIntentHandler;
import androidx.credentials.provider.ProviderGetCredentialRequest;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import org.json.JSONObject;

/**
 * Runs when the user (or agent) picks the blindfill entry. Builds clientDataJSON for the calling
 * app, sends only its hash to the host, and returns the assertion the host signed.
 */
public class PasskeyActivity extends Activity {

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        ProviderGetCredentialRequest req = PendingIntentHandler.retrieveProviderGetCredentialRequest(getIntent());
        Arm arm = Arm.take("passkey");
        GetPublicKeyCredentialOption opt = null;
        if (req != null)
            for (CredentialOption o : req.getCredentialOptions())
                if (o instanceof GetPublicKeyCredentialOption) opt = (GetPublicKeyCredentialOption) o;
        if (req == null || arm == null || opt == null) {
            fail();
            return;
        }
        final GetPublicKeyCredentialOption option = opt;
        CallingAppInfo caller = req.getCallingAppInfo();
        new Thread(() -> {
            try {
                JSONObject r = new JSONObject(option.getRequestJson());
                byte[] signer = Arm.signerDigest(caller.getSigningInfo());
                String clientData = null;
                byte[] hash = option.getClientDataHash();
                if (hash == null) {
                    if (signer == null) throw new IllegalStateException("caller signer cannot be pinned");
                    clientData = new JSONObject()
                            .put("type", "webauthn.get")
                            .put("challenge", r.getString("challenge"))
                            .put("origin", "android:apk-key-hash:" + Arm.b64url(signer))
                            .put("androidPackageName", caller.getPackageName())
                            .toString();
                    hash = MessageDigest.getInstance("SHA-256").digest(clientData.getBytes(StandardCharsets.UTF_8));
                }
                JSONObject s = arm.call(new JSONObject()
                        .put("kind", "passkey")
                        .put("pkg", caller.getPackageName())
                        .put("signer", Arm.hex(signer))
                        .put("web", caller.isOriginPopulated())
                        .put("rpId", r.optString("rpId"))
                        .put("clientDataHash", Arm.b64url(hash)));
                if (!s.optBoolean("ok")) throw new IllegalStateException("refused");
                JSONObject resp = new JSONObject()
                        .put("authenticatorData", s.getString("authenticatorData"))
                        .put("signature", s.getString("signature"))
                        .put("userHandle", s.optString("userHandle"));
                if (clientData != null) resp.put("clientDataJSON", Arm.b64url(clientData.getBytes(StandardCharsets.UTF_8)));
                String json = new JSONObject()
                        .put("id", s.getString("credentialId"))
                        .put("rawId", s.getString("credentialId"))
                        .put("type", "public-key")
                        .put("authenticatorAttachment", "platform")
                        .put("response", resp)
                        .put("clientExtensionResults", new JSONObject())
                        .toString();
                Intent out = new Intent();
                PendingIntentHandler.setGetCredentialResponse(out, new GetCredentialResponse(new PublicKeyCredential(json)));
                runOnUiThread(() -> {
                    setResult(RESULT_OK, out);
                    finish();
                });
            } catch (Exception e) {
                runOnUiThread(this::fail);
            }
        }).start();
    }

    private void fail() {
        Intent out = new Intent();
        PendingIntentHandler.setGetCredentialException(out, new GetCredentialUnknownException("blindfill refused"));
        setResult(RESULT_OK, out);
        finish();
    }
}
