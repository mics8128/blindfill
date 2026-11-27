package io.github.mics8128.blindfill.testrp;

import android.app.Activity;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.text.InputType;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.GetPublicKeyCredentialOption;
import androidx.credentials.PublicKeyCredential;
import androidx.credentials.exceptions.GetCredentialException;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.List;
import org.json.JSONObject;

/**
 * Fake relying party for tests: a login form and a passkey button. It never shows the password,
 * only its SHA-256, and writes the passkey response to its private files dir for the host test.
 */
public class MainActivity extends Activity {
    static final String RP_ID = "blindfill-test.invalid";
    private TextView status;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        LinearLayout l = new LinearLayout(this);
        l.setOrientation(LinearLayout.VERTICAL);
        l.setPadding(48, 160, 48, 48);
        EditText user = new EditText(this);
        user.setHint("username");
        user.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS);
        user.setAutofillHints(View.AUTOFILL_HINT_USERNAME);
        user.setContentDescription("username");
        EditText pw = new EditText(this);
        pw.setHint("password");
        pw.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        pw.setAutofillHints(View.AUTOFILL_HINT_PASSWORD);
        pw.setContentDescription("password");
        Button check = new Button(this);
        check.setText("check");
        Button passkey = new Button(this);
        passkey.setText("passkey");
        status = new TextView(this);
        status.setContentDescription("status");
        status.setText("ready");
        l.addView(user);
        l.addView(pw);
        l.addView(check);
        l.addView(passkey);
        l.addView(status);
        setContentView(l);

        check.setOnClickListener(v -> status.setText(
                "user=" + user.getText() + " pwsha256=" + sha256hex(pw.getText().toString())));
        passkey.setOnClickListener(v -> getPasskey());
    }

    private void getPasskey() {
        try {
            byte[] c = new byte[32];
            new SecureRandom().nextBytes(c);
            String challenge = Base64.getUrlEncoder().withoutPadding().encodeToString(c);
            String json = new JSONObject().put("challenge", challenge).put("rpId", RP_ID)
                    .put("userVerification", "preferred").put("timeout", 60000).toString();
            write("challenge.txt", challenge);
            new File(getFilesDir(), "passkey.json").delete();
            status.setText("passkey: waiting");
            GetCredentialRequest req = new GetCredentialRequest(List.of(new GetPublicKeyCredentialOption(json)));
            CredentialManager.create(this).getCredentialAsync(this, req, new CancellationSignal(), getMainExecutor(),
                    new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
                        @Override
                        public void onResult(GetCredentialResponse r) {
                            if (r.getCredential() instanceof PublicKeyCredential) {
                                write("passkey.json", ((PublicKeyCredential) r.getCredential()).getAuthenticationResponseJson());
                                status.setText("passkey: ok");
                            } else status.setText("passkey: wrong type");
                        }

                        @Override
                        public void onError(GetCredentialException e) {
                            status.setText("passkey: error " + e.getType());
                        }
                    });
        } catch (Exception e) {
            status.setText("passkey: error " + e.getClass().getSimpleName());
        }
    }

    private void write(String name, String s) {
        try (FileOutputStream o = new FileOutputStream(new File(getFilesDir(), name))) {
            o.write(s.getBytes(StandardCharsets.UTF_8));
        } catch (Exception ignored) {
        }
    }

    static String sha256hex(String s) {
        try {
            StringBuilder sb = new StringBuilder();
            for (byte x : MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8)))
                sb.append(String.format("%02x", x));
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
    }
}
