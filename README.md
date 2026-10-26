# On-Call Rota

A fortnightly on-call rota for a small team. Each person marks the days they can do (full shift, either half, or a specific half), and the planner fills every shift as fairly as it can:

- People who offered a shift are always used first.
- When two people offer the same day, it's shared: one does the day half, the other the night half.
- On-call days, weekend days and night halves are evened out across this fortnight and the previous three.
- If nobody offered a shift, it goes to whoever has done the least and had the longest break, and is flagged **Check** so you know who to ask.

The page is plain HTML/JS hosted on GitHub Pages. Data is saved in a Google Sheet you own, through a small Apps Script. Nobody needs an account: the team link opens it.

There are two links. The **team link** lets people see the rota and enter their own availability. The **organiser link** also lets you build the rota, change shifts and edit the team. Only the Google Sheet knows the organiser key, so nobody else can build the rota even if they edit the page.

## Setup (about 15 minutes, once)

### 1. Google Sheet

1. Create a new Google Sheet, for example named **On-call rota**.
2. In the sheet, open **Extensions → Apps Script**.
3. Delete what's in the editor, paste in everything from [`apps-script/Code.gs`](apps-script/Code.gs), and click **Save**.
4. In the function dropdown at the top, choose **setup**, then click **Run**.
   - Google asks you to authorise it. Choose your account, then **Advanced → Go to (project name) (unsafe)** → **Allow**. ("Unsafe" only means Google hasn't reviewed your own script.)
   - The sheet now has a **Setup** tab with your **team key** and **organiser key**.
5. Click **Deploy → New deployment**. Click the cog next to "Select type" and choose **Web app**.
   - **Execute as:** Me
   - **Who has access:** Anyone
   - Click **Deploy** and copy the **Web app URL** (it ends in `/exec`).

### 2. Connect the page

Open [`config.js`](config.js) and paste the Web app URL between the quotes:

```js
window.ROTA_CONFIG = {
  apiUrl: "https://script.google.com/macros/s/…/exec",
};
```

Commit the change.

### 3. GitHub Pages

In the repository on GitHub: **Settings → Pages → Build and deployment**, set **Source** to *Deploy from a branch*, **Branch** to `main` and folder `/ (root)`, then **Save**. After a minute the site is live at `https://<your-username>.github.io/<repo-name>/`.

### 4. Your team link

Back in the Google Sheet's **Setup** tab, paste the site address into **B3**. **B4** then shows the **team link** and **B7** your **organiser link**. Open the organiser link yourself first and add the team. Then send the team link (not the organiser link) to everyone on the rota. The team link is also shown in the app under **Team & shifts → Team link**.

Each person opens the link once on their phone. It's remembered after that, and they can add it to their home screen.

## Good to know

- Anyone with the team link can see the rota and change availability, so keep it within the team. If it leaks, run `resetTeamKey` in Apps Script: the old link stops working and the Setup tab shows the new one.
- Keep the organiser link to yourself. If it leaks, run `resetOrganiserKey`.
- The repository's code and the Web app URL are public. That's fine: every request needs the team key, which only lives in the sheet and in the team link.
- The sheet keeps the data in a hidden `_data` tab. Don't edit it by hand. The **Availability** tab and the **Rota …** tabs are readable copies that update automatically.
- Changes from other people show up within about 20 seconds.
- If you change `Code.gs` later, run `setup` again (it keeps your keys and site address), then use **Deploy → Manage deployments → Edit (pencil) → Version: New version → Deploy** so the Web app URL stays the same.
