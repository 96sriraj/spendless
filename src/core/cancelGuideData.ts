/**
 * cancelGuideData — merchant cancellation steps + name aliases (data only).
 * Extracted from cancelGuide.ts to keep the resolver module under the LOC cap.
 */

export type RawGuide = {
  readonly displayName: string;
  readonly steps: readonly string[];
  readonly url: string;
  readonly deepLink?: string;
};

export const RAW: Record<string, RawGuide> = {
  netflix: {
    displayName: "Netflix",
    steps: ["Open Netflix → Account", "Membership & Billing → Cancel Membership", "Confirm cancellation; access until period end"],
    url: "https://www.netflix.com/cancelplan",
  },
  spotify: {
    displayName: "Spotify",
    steps: ["Open spotify.com/account → Manage plan", "Change plan → Cancel Premium", "Confirm; you revert to Free at period end"],
    url: "https://www.spotify.com/account/cancel/",
  },
  youtube_premium: {
    displayName: "YouTube Premium",
    steps: ["Open youtube.com/paid_memberships", "Manage → Deactivate / Cancel", "Confirm cancellation"],
    url: "https://www.youtube.com/paid_memberships",
  },
  youtube: {
    displayName: "YouTube Premium",
    steps: ["Open youtube.com/paid_memberships", "Manage → Deactivate / Cancel", "Confirm cancellation"],
    url: "https://www.youtube.com/paid_memberships",
  },
  apple_music: {
    displayName: "Apple Music",
    steps: ["iPhone Settings → [Your Name] → Subscriptions", "Select Apple Music → Cancel Subscription", "Confirm"],
    url: "https://apps.apple.com/account/subscriptions",
  },
  apple_one: {
    displayName: "Apple One",
    steps: ["Settings → [Your Name] → Subscriptions", "Select Apple One → Cancel Subscription", "Confirm"],
    url: "https://apps.apple.com/account/subscriptions",
  },
  icloud: {
    displayName: "iCloud+",
    steps: ["Settings → [Your Name] → iCloud → Manage Storage → Change Plan", "Downgrade Options → Free", "Confirm"],
    url: "https://apps.apple.com/account/subscriptions",
  },
  google_one: {
    displayName: "Google One",
    steps: ["Open one.google.com/settings", "Cancel membership → Confirm", "Check Google Play subscriptions if billed via Play"],
    url: "https://one.google.com/settings",
  },
  adobe_cc: {
    displayName: "Adobe Creative Cloud",
    steps: ["Open account.adobe.com → Manage plan", "Cancel plan → Continue → Confirm", "Check refund window for early cancel fee"],
    url: "https://account.adobe.com/plans",
  },
  adobe: {
    displayName: "Adobe Creative Cloud",
    steps: ["Open account.adobe.com → Manage plan", "Cancel plan → Continue → Confirm", "Check refund window for early cancel fee"],
    url: "https://account.adobe.com/plans",
  },
  notion: {
    displayName: "Notion",
    steps: ["Notion → Settings → Billing", "Change plan / Cancel → Downgrade to Free", "Confirm"],
    url: "https://www.notion.so/settings/billing",
  },
  chatgpt_plus: {
    displayName: "ChatGPT Plus",
    steps: ["Open chat.openai.com → My Plan → Manage subscription", "Cancel plan in Stripe portal", "Confirm; access until period end"],
    url: "https://chat.openai.com/#settings",
  },
  openai: {
    displayName: "ChatGPT Plus",
    steps: ["Open chat.openai.com → My Plan → Manage subscription", "Cancel plan in Stripe portal", "Confirm; access until period end"],
    url: "https://chat.openai.com/#settings",
  },
  disney_plus: {
    displayName: "Disney+",
    steps: ["Open disneyplus.com/account", "Manage plan → Cancel Subscription", "Confirm"],
    url: "https://www.disneyplus.com/account",
  },
  hbo_max: {
    displayName: "Max (HBO)",
    steps: ["Open help.max.com → Account → Subscription → Cancel", "Follow prompts; check App Store/Google Play if billed there"],
    url: "https://help.max.com/us/Home",
  },
  prime_video: {
    displayName: "Prime Video",
    steps: ["Open amazon.com → Account → Memberships & Subscriptions", "Manage Prime Video → Cancel", "Confirm"],
    url: "https://www.amazon.com/gp/help/customer/display.html?nodeId=G57RN75REJ5FEC4K",
  },
  hotstar: {
    displayName: "Disney+ Hotstar",
    steps: ["Open hotstar.com → My Account → Subscription", "Cancel / Turn off auto-renew", "Confirm; Billed in INR via App Store/Google Play if applicable"],
    url: "https://www.hotstar.com/in/subscribe",
  },
  jiocinema: {
    displayName: "JioCinema Premium",
    steps: ["Open jiocinema.com → Profile → Plans & Subscription", "Manage → Cancel Premium", "Confirm; check Jio app billing if via Jio"],
    url: "https://www.jiocinema.com/subscription",
  },
  sonyliv: {
    displayName: "SonyLIV",
    steps: ["Open sonyliv.com → Profile → Subscription", "Cancel Subscription → Confirm", "Check App Store/Google Play if billed there; Billed in INR"],
    url: "https://www.sonyliv.com/subscription",
  },
  zee5: {
    displayName: "ZEE5",
    steps: ["Open zee5.com → My Subscription → Manage", "Cancel Premium → Confirm", "Verify email for cancellation confirmation"],
    url: "https://www.zee5.com/myaccount/subscription",
  },
  gaana: {
    displayName: "Gaana Plus",
    steps: ["Open gaana.com → Profile → Gaana Plus", "Manage Subscription → Cancel", "Confirm; Billed in INR"],
    url: "https://gaana.com/plus",
  },
  jiosaavn: {
    displayName: "JioSaavn Pro",
    steps: ["Open jiosaavn.com → My Music → JioSaavn Pro", "Manage → Cancel Subscription", "Confirm; check JioSaavn app billing"],
    url: "https://www.jiosaavn.com/pro",
  },
  youtube_india: {
    displayName: "YouTube Premium India",
    steps: ["Open youtube.com/paid_memberships (India)", "Manage → Deactivate Premium → Confirm", "Billed in INR; check Google Play if via Android"],
    url: "https://www.youtube.com/paid_memberships",
  },
  google_one_india: {
    displayName: "Google One India",
    steps: ["Open one.google.com/settings (India)", "Cancel membership → Confirm", "Billed in INR via Google Play; check play.google.com subscriptions"],
    url: "https://one.google.com/settings",
  },
  adobe_india: {
    displayName: "Adobe India",
    steps: ["Open account.adobe.com (India) → Manage plan", "Cancel plan → Continue → Confirm", "Billed in INR; check refund window for annual plan"],
    url: "https://account.adobe.com/plans",
  },
  airtel_xstream: {
    displayName: "Airtel Xstream",
    steps: ["Open airtelxstream.in → Profile → Subscription", "Manage → Cancel Auto-renew → Confirm", "Check Airtel Thanks app if billed via Airtel; Billed in INR"],
    url: "https://www.airtelxstream.in/",
  },
};

export const ALIAS: Record<string, string> = {
  netflix: "netflix",
  spotify: "spotify",
  youtube: "youtube",
  "youtube premium": "youtube_premium",
  "youtube_premium": "youtube_premium",
  "apple music": "apple_music",
  "apple one": "apple_one",
  icloud: "icloud",
  "icloud+": "icloud",
  "google one": "google_one",
  adobe: "adobe",
  "adobe cc": "adobe_cc",
  "creative cloud": "adobe_cc",
  notion: "notion",
  chatgpt: "chatgpt_plus",
  "chatgpt plus": "chatgpt_plus",
  openai: "openai",
  "disney": "disney_plus",
  "disney+": "disney_plus",
  "disney plus": "disney_plus",
  "hbo": "hbo_max",
  "hbo max": "hbo_max",
  max: "hbo_max",
  "prime video": "prime_video",
  "amazon prime": "prime_video",
  hotstar: "hotstar",
  "disney+ hotstar": "hotstar",
  "disney hotstar": "hotstar",
  jiocinema: "jiocinema",
  "jio cinema": "jiocinema",
  "jio_cinema": "jiocinema",
  sonyliv: "sonyliv",
  "sony liv": "sonyliv",
  "sony_liv": "sonyliv",
  zee5: "zee5",
  "zee 5": "zee5",
  gaana: "gaana",
  jiosaavn: "jiosaavn",
  "jio saavn": "jiosaavn",
  "jio_saavn": "jiosaavn",
  saavn: "jiosaavn",
  "youtube india": "youtube_india",
  "youtube_india": "youtube_india",
  "google one india": "google_one_india",
  "google_one_india": "google_one_india",
  "adobe india": "adobe_india",
  "adobe_india": "adobe_india",
  "airtel xstream": "airtel_xstream",
  "airtel_xstream": "airtel_xstream",
  xstream: "airtel_xstream",
  "airtel": "airtel_xstream",
};
