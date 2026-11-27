package io.github.mics8128.blindfill;

import android.app.PendingIntent;
import android.content.Intent;
import android.os.CancellationSignal;
import android.os.OutcomeReceiver;
import androidx.credentials.exceptions.ClearCredentialException;
import androidx.credentials.exceptions.CreateCredentialException;
import androidx.credentials.exceptions.GetCredentialException;
import androidx.credentials.provider.BeginCreateCredentialRequest;
import androidx.credentials.provider.BeginCreateCredentialResponse;
import androidx.credentials.provider.BeginGetCredentialOption;
import androidx.credentials.provider.BeginGetCredentialRequest;
import androidx.credentials.provider.BeginGetCredentialResponse;
import androidx.credentials.provider.BeginGetPublicKeyCredentialOption;
import androidx.credentials.provider.CredentialEntry;
import androidx.credentials.provider.CredentialProviderService;
import androidx.credentials.provider.ProviderClearCredentialStateRequest;
import androidx.credentials.provider.PublicKeyCredentialEntry;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONObject;

/**
 * Passkey sign-in for native apps. Offers one entry only while the host has armed a passkey
 * request for that rpId; the signature itself is made on the host (PasskeyActivity), so the
 * private key never reaches the phone. Creating passkeys is not supported.
 */
public class PasskeyProvider extends CredentialProviderService {

    @Override
    public void onBeginGetCredentialRequest(BeginGetCredentialRequest request, CancellationSignal cancel,
            OutcomeReceiver<BeginGetCredentialResponse, GetCredentialException> cb) {
        List<CredentialEntry> entries = new ArrayList<>();
        Arm arm = Arm.peek("passkey");
        if (arm != null) {
            for (BeginGetCredentialOption o : request.getBeginGetCredentialOptions()) {
                if (!(o instanceof BeginGetPublicKeyCredentialOption)) continue;
                BeginGetPublicKeyCredentialOption pk = (BeginGetPublicKeyCredentialOption) o;
                String rp;
                try {
                    rp = new JSONObject(pk.getRequestJson()).optString("rpId");
                } catch (Exception e) {
                    continue;
                }
                if (!rp.equals(arm.rpId)) continue;
                PendingIntent pi = PendingIntent.getActivity(this, 1, new Intent(this, PasskeyActivity.class),
                        PendingIntent.FLAG_MUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
                entries.add(new PublicKeyCredentialEntry.Builder(this, arm.user.isEmpty() ? arm.item : arm.user, pi, pk)
                        .setDisplayName("blindfill: " + arm.item)
                        .build());
            }
        }
        cb.onResult(new BeginGetCredentialResponse.Builder().setCredentialEntries(entries).build());
    }

    @Override
    public void onBeginCreateCredentialRequest(BeginCreateCredentialRequest request, CancellationSignal cancel,
            OutcomeReceiver<BeginCreateCredentialResponse, CreateCredentialException> cb) {
        cb.onResult(new BeginCreateCredentialResponse.Builder().build()); // no create entries
    }

    @Override
    public void onClearCredentialStateRequest(ProviderClearCredentialStateRequest request, CancellationSignal cancel,
            OutcomeReceiver<Void, ClearCredentialException> cb) {
        cb.onResult(null);
    }
}
