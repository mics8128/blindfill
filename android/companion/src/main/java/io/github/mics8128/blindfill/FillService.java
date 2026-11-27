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
import android.util.Pair;
import android.view.View;
import android.view.ViewStructure.HtmlInfo;
import android.view.autofill.AutofillId;
import android.view.autofill.AutofillValue;
import android.widget.RemoteViews;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import org.json.JSONObject;

/**
 * Password fill for native apps and their WebViews. The requesting package comes from the system
 * (AssistStructure), its signer from PackageManager, a WebView's document scheme and domain from
 * the view nodes; the host checks them against the vault item before it sends anything. Armed as
 * "password" it fills a login screen, as "password-new" a sign-up screen (the same password into
 * the password and its confirmation). Nothing is stored; the values exist only inside the Dataset.
 */
public class FillService extends AutofillService {

    private static final class Scan {
        AutofillId user, lastText;
        final List<AutofillId> passwordIds = new ArrayList<>();
        boolean newPassword;
        final Set<String> webDomains = new LinkedHashSet<>(), webSchemes = new LinkedHashSet<>();
    }

    @Override
    public void onFillRequest(FillRequest request, CancellationSignal cancel, FillCallback cb) {
        Arm arm = Arm.peek("password");
        if (arm == null) arm = Arm.peek("password-new");
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
        if (s.passwordIds.isEmpty()) {
            cb.onSuccess(null); // not a login or sign-up screen: stay armed for the next one
            return;
        }
        Arm taken = Arm.take(arm.mode);
        if (taken == null) {
            cb.onSuccess(null);
            return;
        }
        // the host needs exactly one domain and the scheme "https" ("mixed" when nodes disagree)
        String domain = s.webDomains.isEmpty() ? null : s.webDomains.iterator().next();
        String scheme = s.webSchemes.size() == 1 ? s.webSchemes.iterator().next() : s.webSchemes.isEmpty() ? null : "mixed";
        new Thread(() -> {
            try {
                JSONObject req = new JSONObject()
                        .put("kind", taken.mode)
                        .put("pkg", pkg)
                        .put("signer", Arm.hex(Arm.signerDigest(getPackageManager(), pkg)))
                        .put("web", domain != null)
                        .put("passwords", s.passwordIds.size())
                        .put("newPassword", s.newPassword);
                if (domain != null)
                    req.put("webDomain", domain).put("webDomains", s.webDomains.size()).put("webScheme", scheme);
                JSONObject r = taken.call(req);
                if (!r.optBoolean("ok")) {
                    cb.onSuccess(null);
                    return;
                }
                RemoteViews rv = new RemoteViews(getPackageName(), android.R.layout.simple_list_item_1);
                rv.setTextViewText(android.R.id.text1, "blindfill: " + taken.item);
                Dataset.Builder d = new Dataset.Builder(new Presentations.Builder().setMenuPresentation(rv).build());
                AutofillValue pw = AutofillValue.forText(r.getString("password"));
                // login: the one password field; sign-up: the password and its confirmation (the host checked there are <= 2)
                int n = "password-new".equals(taken.mode) ? Math.min(2, s.passwordIds.size()) : 1;
                for (int i = 0; i < n; i++) d.setField(s.passwordIds.get(i), new Field.Builder().setValue(pw).build());
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
        if (n.getWebDomain() != null) {
            s.webDomains.add(n.getWebDomain().toLowerCase());
            if (n.getWebScheme() != null) s.webSchemes.add(n.getWebScheme().toLowerCase());
        }
        if (n.getAutofillId() != null && n.getAutofillType() == View.AUTOFILL_TYPE_TEXT) {
            String hints = n.getAutofillHints() == null ? "" : String.join(",", n.getAutofillHints()).toLowerCase();
            // WebView inputs: <input type autocomplete> arrive as HtmlInfo attributes
            String htmlType = "", autocomplete = "";
            HtmlInfo html = n.getHtmlInfo();
            if (html != null && html.getAttributes() != null)
                for (Pair<String, String> a : html.getAttributes()) {
                    if ("type".equals(a.first)) htmlType = String.valueOf(a.second).toLowerCase();
                    else if ("autocomplete".equals(a.first)) autocomplete = String.valueOf(a.second).toLowerCase();
                }
            int t = n.getInputType();
            int cls = t & InputType.TYPE_MASK_CLASS, v = t & InputType.TYPE_MASK_VARIATION;
            boolean pw = hints.contains("password") || htmlType.equals("password") || autocomplete.contains("password")
                    || (cls == InputType.TYPE_CLASS_TEXT && (v == InputType.TYPE_TEXT_VARIATION_PASSWORD
                            || v == InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
                            || v == InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD))
                    || (cls == InputType.TYPE_CLASS_NUMBER && v == InputType.TYPE_NUMBER_VARIATION_PASSWORD);
            if (pw) {
                s.passwordIds.add(n.getAutofillId());
                if (hints.contains("new") || autocomplete.contains("new-password")) s.newPassword = true;
            } else if (s.passwordIds.isEmpty()) {
                boolean user = hints.contains("username") || hints.contains("email")
                        || autocomplete.contains("username") || autocomplete.contains("email")
                        || htmlType.equals("email")
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
