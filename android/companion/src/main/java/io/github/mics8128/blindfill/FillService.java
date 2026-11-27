package io.github.mics8128.blindfill;

import android.app.assist.AssistStructure;
import android.app.assist.AssistStructure.ViewNode;
import android.os.CancellationSignal;
import android.service.autofill.AutofillService;
import android.service.autofill.Dataset;
import android.service.autofill.Field;
import android.service.autofill.FillCallback;
import android.service.autofill.FillRequest;
import android.service.autofill.FillResponse;
import android.service.autofill.Presentations;
import android.service.autofill.SaveCallback;
import android.service.autofill.SaveRequest;
import android.text.InputType;
import android.view.View;
import android.view.autofill.AutofillId;
import android.view.autofill.AutofillValue;
import android.widget.RemoteViews;
import java.util.List;
import org.json.JSONObject;

/**
 * Password fill for native apps. The requesting package comes from the system (AssistStructure),
 * its signer from PackageManager; the host checks both against the vault item before it sends
 * anything. Nothing is stored; the values exist only inside the returned Dataset.
 */
public class FillService extends AutofillService {

    private static final class Scan {
        AutofillId user, password, lastText;
        int passwords;
        boolean web, newPassword;
    }

    @Override
    public void onFillRequest(FillRequest request, CancellationSignal cancel, FillCallback cb) {
        Arm arm = Arm.peek("password");
        if (arm == null) {
            cb.onSuccess(null);
            return;
        }
        List<android.service.autofill.FillContext> ctx = request.getFillContexts();
        AssistStructure st = ctx.get(ctx.size() - 1).getStructure();
        String pkg = st.getActivityComponent().getPackageName();
        if (pkg.equals(getPackageName())) {
            cb.onSuccess(null);
            return;
        }
        Scan s = new Scan();
        for (int w = 0; w < st.getWindowNodeCount(); w++) walk(st.getWindowNodeAt(w).getRootViewNode(), s);
        if (s.password == null) {
            cb.onSuccess(null); // not a login screen: stay armed for the next one
            return;
        }
        Arm taken = Arm.take("password");
        if (taken == null) {
            cb.onSuccess(null);
            return;
        }
        new Thread(() -> {
            try {
                JSONObject r = taken.call(new JSONObject()
                        .put("kind", "password")
                        .put("pkg", pkg)
                        .put("signer", Arm.hex(Arm.signerDigest(getPackageManager(), pkg)))
                        .put("web", s.web)
                        .put("passwords", s.passwords)
                        .put("newPassword", s.newPassword));
                if (!r.optBoolean("ok")) {
                    cb.onSuccess(null);
                    return;
                }
                RemoteViews rv = new RemoteViews(getPackageName(), android.R.layout.simple_list_item_1);
                rv.setTextViewText(android.R.id.text1, "blindfill: " + taken.item);
                Dataset.Builder d = new Dataset.Builder(new Presentations.Builder().setMenuPresentation(rv).build());
                d.setField(s.password, new Field.Builder().setValue(AutofillValue.forText(r.getString("password"))).build());
                AutofillId u = s.user != null ? s.user : s.lastText;
                if (u != null && !r.optString("username").isEmpty())
                    d.setField(u, new Field.Builder().setValue(AutofillValue.forText(r.getString("username"))).build());
                cb.onSuccess(new FillResponse.Builder().addDataset(d.build()).build());
            } catch (Exception e) {
                cb.onSuccess(null); // fail closed, and never put a message that could carry data in the UI
            }
        }).start();
    }

    private static void walk(ViewNode n, Scan s) {
        if (n.getWebDomain() != null) s.web = true;
        if (n.getAutofillId() != null && n.getAutofillType() == View.AUTOFILL_TYPE_TEXT) {
            String hints = n.getAutofillHints() == null ? "" : String.join(",", n.getAutofillHints()).toLowerCase();
            int t = n.getInputType();
            int cls = t & InputType.TYPE_MASK_CLASS, v = t & InputType.TYPE_MASK_VARIATION;
            boolean pw = hints.contains("password")
                    || (cls == InputType.TYPE_CLASS_TEXT && (v == InputType.TYPE_TEXT_VARIATION_PASSWORD
                            || v == InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
                            || v == InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD))
                    || (cls == InputType.TYPE_CLASS_NUMBER && v == InputType.TYPE_NUMBER_VARIATION_PASSWORD);
            if (pw) {
                s.passwords++;
                if (hints.contains("new")) s.newPassword = true;
                if (s.password == null) s.password = n.getAutofillId();
            } else if (s.password == null) {
                boolean user = hints.contains("username") || hints.contains("email")
                        || (cls == InputType.TYPE_CLASS_TEXT && (v == InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS
                                || v == InputType.TYPE_TEXT_VARIATION_WEB_EMAIL_ADDRESS));
                if (user) s.user = n.getAutofillId();
                else s.lastText = n.getAutofillId();
            }
        }
        for (int i = 0; i < n.getChildCount(); i++) walk(n.getChildAt(i), s);
    }

    @Override
    public void onSaveRequest(SaveRequest request, SaveCallback cb) {
        cb.onSuccess(); // never saves: the vault is written only from the host
    }
}
