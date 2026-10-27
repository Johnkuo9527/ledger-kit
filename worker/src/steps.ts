/// The daily engine, in the order one tick runs it:
/// today's mail (check Gmail every 15 minutes → read the new bank alerts → the
/// watch that raises an alarm when mail waits → the watch for a bank gone
/// quiet) → FX rates → the backfills →
/// the daily pull (the net under the mail check) → the one-time catch-up of
/// bank mail missed since 13 Oct 2026 → the work queue → a prepaid shop's SMS → categories
/// → upkeep → escalations → email. Today's mail goes first so no heavy work
/// (FX history, older months, uploads, statements read again) can hold it up.
/// Each step decides for itself whether it has anything to do this minute.

import { backfill } from "./backfill";
import { categorise, sortMerchants } from "./categorise";
import { dryRun } from "./dryrun";
import { escalations } from "./escalate";
import { backfillExtra } from "./extend";
import { fxFeed } from "./fx-feed";
import { learnPatterns } from "./learn";
import { mailWatch, todaysMail, workQueue } from "./pipeline";
import { readerWatch } from "./reader";
import { alertSilence } from "./silence";
import { bankRelist, dailyPull, mailCheck } from "./pull";
import type { Step } from "./tick";
import { cardCounters, lookBack, upkeep } from "./upkeep";
import { walletTidy } from "./wallet-upkeep";
import { walletSms } from "./sms";
import { creditCheck, urgentMail, weekly } from "./weekly";

export const ENGINE_STEPS: readonly Step[] = [mailCheck, todaysMail, mailWatch, readerWatch, alertSilence, fxFeed, dryRun, backfill, backfillExtra, dailyPull, bankRelist, workQueue, walletSms, learnPatterns, lookBack, cardCounters, sortMerchants, categorise, upkeep, walletTidy, escalations, creditCheck, urgentMail, weekly];
