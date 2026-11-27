package io.github.mics8128.blindfill;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import androidx.credentials.CredentialOption;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.GetPasswordOption;
import androidx.credentials.PasswordCredential;
import androidx.credentials.exceptions.GetCredentialUnknownException;
import androidx.credentials.provider.CallingAppInfo;
import androidx.credentials.provider.PendingIntentHandler;
import androidx.credentials.provider.ProviderGetCredentialRequest;
import org.json.JSONObject;

/**
 * Credential Manager password sign-in (GetPasswordOption), for apps that ask Credential Manager
 * instead of relying on autofill. Runs when the blindfill entry is picked: reports the calling app
 * (package and signer from the system) and returns the username and password the host sent.
 */
public class PasswordActivity extends Activity {

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        ProviderGetCredentialRequest req = PendingIntentHandler.retrieveProviderGetCredentialRequest(getIntent());
        Arm arm = Arm.take("password");
        boolean asked = false;
        if (req != null)
            for (CredentialOption o : req.getCredentialOptions()) if (o instanceof GetPasswordOption) asked = true;
        if (req == null || arm == null || !asked) {
            fail();
            return;
        }
        CallingAppInfo caller = req.getCallingAppInfo();
        new Thread(() -> {
            try {
                JSONObject r = arm.call(new JSONObject()
                        .put("kind", "password")
                        .put("cm", true)
                        .put("pkg", caller.getPackageName())
                        .put("signer", Arm.hex(Arm.signerDigest(caller.getSigningInfo())))
                        .put("web", caller.isOriginPopulated()));
                if (!r.optBoolean("ok")) throw new IllegalStateException("refused");
                Intent out = new Intent();
                PendingIntentHandler.setGetCredentialResponse(out,
                        new GetCredentialResponse(new PasswordCredential(r.getString("username"), r.getString("password"))));
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
