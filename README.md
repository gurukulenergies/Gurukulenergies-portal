# Gurukul Energies Tenant Portal - Setup Guide (no coding needed)

You will do 4 things: (A) put the files on GitHub, (B) host them on Render, (C) turn on Razorpay payments, (D) connect the Billing Office.
Keep a notepad open: you will copy a few secret values between websites.

---
## A. Put the files on GitHub (5 min, no git knowledge)
1. Go to github.com and sign up (free). Click **+** (top right) > **New repository**.
2. Name it `tenant-portal`, choose **Private**, click **Create repository**.
3. Click **uploading an existing file**.
4. Unzip `tenant-portal-site.zip` on your computer. Open the unzipped `site` folder, select EVERYTHING inside it
   (`server.js`, `package.json`, `render.yaml`, the `public` folder, ...) and drag it into the GitHub page.
5. Click **Commit changes**.

## B. Host it on Render (10 min)
1. Go to render.com and sign up with your GitHub account.
2. **New +** > **Blueprint** > choose your `tenant-portal` repo > **Apply**. (It reads `render.yaml`.)
   It asks for 3 Razorpay values: skip them for now (type `x`), you will fill them in section C.
3. When deploy finishes, open the `https://....onrender.com` link. You should see the portal page.
4. In Render > your service > **Environment**, find `ADMIN_KEY`. Copy it to your notepad (this is your Billing Office password).
5. Cost: the persistent disk that keeps your bills needs a paid Render instance (about US$7/month at the time of writing; check Render's pricing page).

## C. Turn on automatic payments with Razorpay
1. Sign up at razorpay.com with your business details and complete KYC. Real payments only work after Razorpay approves your account.
   Use **Test Mode** first: you can try fake payments without real money.
2. Dashboard > **Account & Settings > API Keys > Generate Key**. Copy **Key Id** and **Key Secret** to your notepad.
3. Dashboard > **Account & Settings > Webhooks > Add new webhook**:
   - URL: `https://YOUR-RENDER-ADDRESS/api/razorpay/webhook`
   - Secret: invent a long password; copy it to your notepad.
   - Tick **payment.authorized**, **payment.captured** and **order.paid**. Save.
4. Dashboard > **Payment Capture settings**: set to **Automatic** capture.
5. Back on Render > Environment, set:
   `RAZORPAY_KEY_ID` = Key Id, `RAZORPAY_KEY_SECRET` = Key Secret, `RAZORPAY_WEBHOOK_SECRET` = your webhook password.
   Save. Render restarts the site.
6. Test (Test Mode): open your portal, search a bill, click **Pay Now**, pay with Razorpay's test UPI/card.
   The bill should switch to PAID by itself. Then switch Razorpay to Live Mode and replace the Key Id and Secret with the Live ones.

How it works: the amount is always taken from the server's bill, never from the browser. A bill turns PAID only after the server
confirms the payment directly with Razorpay. The webhook covers tenants who close the page right after paying.
Razorpay charges its own fee per payment (UPI, card and net banking fees differ; see their pricing).

## D. Connect the Billing Office
1. Open the bill generator > **Ledger** > **Portal Settings**. Enter your portal address and the `ADMIN_KEY`.
2. Click **Sync All to Portal** once.
3. From then on, every saved bill goes to the portal, and online payments come back into your ledger as PAID
   (checked every minute, and each time you open the Ledger).
   If you manually set a bill back to UNPAID in the ledger, that change wins over the online payment.

## E. Get found on Google
1. Buy a domain and attach it in Render > Settings > Custom Domains.
2. Replace `YOUR-DOMAIN.com` with your real domain in `public/index.html`, `public/robots.txt`, `public/sitemap.xml`
   (on GitHub: open the file > pencil icon > edit > Commit).
3. search.google.com/search-console > add your domain > submit `sitemap.xml` > Request indexing.
   Listing takes days to weeks. Individual bills are never indexed.

## Security notes
- Only one bill can be fetched at a time, by 5-digit code, with rate limits. Codes are short, so guessing is slow but not impossible.
- Never share `ADMIN_KEY` or `RAZORPAY_KEY_SECRET`. If one leaks, regenerate it and update Render and Portal Settings.
