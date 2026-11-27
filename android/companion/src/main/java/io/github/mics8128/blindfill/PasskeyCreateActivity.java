package io.github.mics8128.blindfill;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import androidx.credentials.CreatePublicKeyCredentialRequest;
import androidx.credentials.CreatePublicKeyCredentialResponse;
import androidx.credentials.exceptions.CreateCredentialUnknownException;
import androidx.credentials.provider.CallingAppInfo;
import androidx.credentials.provider.PendingIntentHandler;
import androidx.credentials.provider.ProviderCreateCredentialRequest;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Runs when the user (or agent) picks the blindfill create entry. Builds clientDataJSON for the
 * calling app and sends its hash, the rp, user id and algorithms to the host, which makes and
 * stores the key; the phone only relays the attestation back to the app.
 */
public class PasskeyCreateActivity extends Activity {

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        ProviderCreateCredentialRequest req = PendingIntentHandler.retrieveProviderCreateCredentialRequest(getIntent());
        Arm arm = Arm.take("passkey-create");
        if (req == null || arm == null || !(req.getCallingRequest() instanceof CreatePublicKeyCredentialRequest)) {
            fail();
            return;
        }
        final CreatePublicKeyCredentialRequest option = (CreatePublicKeyCredentialRequest) req.getCallingRequest();
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
                            .put("type", "webauthn.create")
                            .put("challenge", r.getString("challenge"))
                            .put("origin", "android:apk-key-hash:" + Arm.b64url(signer))
                            .put("androidPackageName", caller.getPackageName())
                            .toString();
                    hash = MessageDigest.getInstance("SHA-256").digest(clientData.getBytes(StandardCharsets.UTF_8));
                }
                JSONArray algs = new JSONArray();
                JSONArray params = r.optJSONArray("pubKeyCredParams");
                for (int i = 0; params != null && i < params.length(); i++)
                    algs.put(params.getJSONObject(i).optInt("alg"));
                JSONObject s = arm.call(new JSONObject()
                        .put("kind", "passkey-create")
                        .put("pkg", caller.getPackageName())
                        .put("signer", Arm.hex(signer))
                        .put("web", caller.isOriginPopulated())
                        .put("rpId", r.getJSONObject("rp").optString("id"))
                        .put("userId", r.getJSONObject("user").optString("id"))
                        .put("algs", algs)
                        .put("clientDataHash", Arm.b64url(hash)));
                if (!s.optBoolean("ok")) throw new IllegalStateException("refused");
                JSONObject resp = new JSONObject()
                        .put("attestationObject", s.getString("attestationObject"))
                        .put("authenticatorData", s.getString("authenticatorData"))
                        .put("publicKey", s.getString("publicKey"))
                        .put("publicKeyAlgorithm", s.getInt("publicKeyAlgorithm"))
                        .put("transports", new JSONArray().put("internal").put("hybrid"));
                if (clientData != null) resp.put("clientDataJSON", Arm.b64url(clientData.getBytes(StandardCharsets.UTF_8)));
                String json = new JSONObject()
                        .put("id", s.getString("credentialId"))
                        .put("rawId", s.getString("credentialId"))
                        .put("type", "public-key")
                        .put("authenticatorAttachment", "platform")
                        .put("response", resp)
                        .put("clientExtensionResults", new JSONObject().put("credProps", new JSONObject().put("rk", true)))
                        .toString();
                Intent out = new Intent();
                PendingIntentHandler.setCreateCredentialResponse(out, new CreatePublicKeyCredentialResponse(json));
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
        PendingIntentHandler.setCreateCredentialException(out, new CreateCredentialUnknownException("blindfill refused"));
        setResult(RESULT_OK, out);
        finish();
    }
}
