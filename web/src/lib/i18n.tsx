"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

export type Lang = "en" | "ar";

// Interface strings only. The question the user types and the answer they get back stay in whatever
// language they used — this never touches that content.
const DICT: Record<Lang, Record<string, string>> = {
  en: {
    "hero.title": "Ask across the archive",
    "hero.subtitle":
      "Not a fatwa — the words of the scholars themselves, drawn from thousands of hours of lectures and debates and traced to the exact moment they were said, with a timestamp you can open on the video.",
    "hero.videos": "videos",
    "hero.moments": "searchable moments",
    "hero.channels": "channels",
    "hero.try": "Try one of these",

    "ex.1": "What is the correct belief about Allah's names and attributes?",
    "ex.2": "Is wudu valid with seawater?",
    "ex.3": 'How do the scholars respond to John 1:1, "the Word was God"?',

    "ask.placeholder": "Ask anything…  (English or Arabic)",
    "ask.submit": "Ask",
    "controls.pickChannel": "Pick a channel",
    "controls.pickOne": "Pick at least one channel.",
    "controls.channelCount": "{n} channel{s}",
    "controls.perAnswer": "≈ {price} per answer",
    "style.topical": "Topical",
    "style.verbatim": "Verbatim",
    "style.disclaimer": "Topical answer — synthesized by AI from the scholars' words. It can make mistakes and translations are approximate, so double-check against the original sources.",

    "stage.1": "Breaking your question into angles",
    "stage.2": "Searching a million moments",
    "stage.3": "Reading the most relevant ones",
    "stage.4": "Writing a grounded answer",
    "loading.note": "A thorough answer takes a few moments.",

    "answer.skip": "Skip to videos",
    "answer.findingVideos": "Finding the videos",
    "answer.cost": "This answer cost {cost}",
    "answer.coverage": "Drew on {moments} moments across {videos} videos",
    "answer.cited": " · cited {n} from {channels} channel{s}",
    "answer.empty": "Nothing matched that one. Try different words, or rephrase.",
    "sources.title": "Sources",
    "source.read": "Read transcript",
    "source.hide": "Hide transcript",
    "source.open": "Open this moment on YouTube",
    "source.download": "Download transcript",
    "source.dlError": "Couldn't load the transcript. Try again.",
    "quote.quran": "Quran",
    "quote.matchesQuran": "This moment matches these verses",
    "quote.matchesHadith": "This moment matches this hadith",
    "quote.full": "Show the whole hadith",
    "quote.less": "Show less",
    "quote.grade": "Grading",
    "quote.alsoIn": "Also in",
    "quote.note": "Matched automatically from the lecture's wording.",
    "quote.quranSource": "Text:",
    "quote.hadithSource": "Text:",
    "cite.loading": "The answer is still loading — the sources will appear below in a moment.",
    "cite.missing": "That source isn't available.",

    "sidebar.new": "New question",
    "sidebar.empty": "Your questions are saved here as you ask them.",
    "sidebar.theme": "Theme",
    "sidebar.admin": "Admin",
    "sidebar.answersToday": "{used}/{cap} answers today",
    "aria.signout": "Sign out",
    "aria.collapse": "Collapse sidebar",
    "aria.openMenu": "Open menu",
    "aria.deleteQuestion": "Delete question",
    "footer.privacy": "Privacy",
    "footer.terms": "Terms",

    "err.signInAgain": "Please sign in again.",
    "err.server": "Could not reach the server.",
    "err.generic": "Something went wrong.",
    "err.interrupted": "That answer was interrupted before it finished. Please ask again.",

    "signin.welcome": "Welcome back",
    "signin.createTitle": "Create your account",
    "signin.tagline": "The words of the scholars themselves, traced to the moment they were said.",
    "signin.google": "Continue with Google",
    "signin.or": "or",
    "signin.email": "Email",
    "signin.password": "Password",
    "signin.signIn": "Sign in",
    "signin.create": "Create account",
    "signin.newHere": "New here? ",
    "signin.createOne": "Create one",
    "signin.haveAccount": "Already have an account? ",
    "signin.signInShort": "Sign in",
    "signin.agree": "By continuing you agree to our {terms} and {privacy}.",
    "signin.terms": "Terms",
    "signin.privacy": "Privacy Policy",
    "signin.err.wrong": "Wrong email or password.",
    "signin.err.inUse": "That email already has an account — try signing in.",
    "signin.err.weak": "Password should be at least 6 characters.",
    "signin.err.invalidEmail": "That doesn't look like a valid email.",
    "signin.err.tooMany": "Too many tries — wait a moment and try again.",
    "signin.err.generic": "Something went wrong. Please try again.",
    "signin.guest": "Continue as guest",
    "signin.guestHint": "2 questions, no account needed.",
    "signin.err.guestOff": "Guest mode isn't available right now.",
    "guest.label": "Guest",
    "guest.usage": "{used}/{cap} free questions",
    "guest.prompt.title": "That's your free questions",
    "guest.prompt.body": "Create a free account or sign in to keep asking — it's free.",
    "guest.prompt.create": "Create free account",
    "guest.prompt.signin": "Sign in",

    "admin.tab.accounts": "Accounts",
    "admin.tab.channels": "Channels",
    "admin.close": "Close",
    "admin.accounts.help": "Daily answer limit per account (blank = default {cap}).",
    "admin.accounts.helpChannels": " Expand an account to show hidden channels to just them.",
    "admin.loading": "Loading…",
    "admin.noAccounts": "No accounts yet.",
    "admin.save": "Save",
    "admin.today": "{used}/{cap} today",
    "admin.default": " · default",
    "admin.channelAccess": "Channel access",
    "admin.shownCount": " · {n} shown",
    "admin.shown": "Shown",
    "admin.hidden": "Hidden",
    "admin.visible": "Visible",
    "admin.saveAccess": "Save access",
    "admin.channels.help": "Set each channel's English and Arabic name, and hide any you don't want non-admin accounts to see (hidden ones are left out of their picker and answers).",
    "admin.channels.enName": "English name",
    "admin.channels.arName": "Arabic name",
    "admin.noChannels": "No channels yet.",
    "admin.saveChanges": "Save changes",
    "admin.saving": "Saving…",
    "admin.couldntLoadAccounts": "Couldn't load accounts.",
    "admin.couldntLoadChannels": "Couldn't load channels.",
    "admin.couldntReach": "Couldn't reach the server.",

    "whatsnew.title": "What's new",
    "whatsnew.dismiss": "Got it",
    "whatsnew.history.t": "Your question history",
    "whatsnew.history.b": "Every question you ask is now saved in the sidebar — reopen any of them anytime.",
    "whatsnew.arabic.t": "Arabic interface",
    "whatsnew.arabic.b": "Switch the whole app between English and العربية with the toggle at the top.",
    "whatsnew.answers.t": "Smoother answers",
    "whatsnew.answers.b": "Answers now stream more smoothly and read more cleanly.",
    "whatsnew.verbatim.t": "Verbatim mode",
    "whatsnew.verbatim.b": "A new Topical / Verbatim toggle — read the scholars' exact words in the original language, or a synthesized overview.",
    "whatsnew.whosaid.t": "Who said what",
    "whatsnew.whosaid.b": "Answers now attribute each point to its channel and keep differing views side by side — what was said, not one blended verdict.",
    "whatsnew.comprehensive.t": "Fuller, deeper answers",
    "whatsnew.comprehensive.b": "Answers now lay out each channel's stance in depth, with headings and quotes — if a matter is discussed in many places, you get all of them, not a sample.",
    "whatsnew.download.t": "Download transcripts",
    "whatsnew.download.b": "Every source now has a download button for that video's full transcript.",
    "whatsnew.resume.t": "Answers keep going when you leave",
    "whatsnew.resume.b": "Switch apps or lock your phone mid-answer — it keeps being written, and it's there in full when you come back.",
    "whatsnew.quotes.t": "Quran & hadith references",
    "whatsnew.quotes.b": "When a scholar recites a verse or a hadith, the source now shows which one it matches — the verse in Uthmani script, or the hadith with its book, number and grading. Arabic lectures for now.",
    "whatsnew.fixes.t": "Small fixes",
    "whatsnew.fixes.b": "Tidied up answer alignment when English and Arabic are mixed, plus other minor polish.",

    "mode.custom": "Custom",
    "custom.title": "Custom depth — admin",
    "custom.upto": "up to ≈ {price}",
    "custom.moments.label": "Moments to read",
    "custom.moments.unit": "moments",
    "custom.moments.help": "How many transcript moments the model reads in. More = wider coverage — but past ~1,000–2,000 you mostly add cost and noise, not coverage: relevance runs out before the number does.",
    "custom.tokens.label": "Answer length",
    "custom.tokens.unit": "tokens",
    "custom.tokens.help": "The most the answer may write (a token ≈ ¾ word). A ceiling, not a target — raising it won't pad a short answer, only free a long one. ~16k ≈ 12k words; max 32k.",
    "custom.note": "This is an upper estimate — the answer usually costs less, since it stops once it has said everything relevant. The real cost shows with each answer.",
    "channels.selectAll": "Select all",
    "channels.deselectAll": "Deselect all",
    "channels.clear": "Clear",
    "admin.defaultCapLabel": "Default daily limit (everyone):",
    "whatsnew.polish.t": "More small fixes",
    "whatsnew.polish.b": "Saved answers keep their style, deleting a chat is easier on mobile, and you can Select or Deselect all channels in one tap.",
    "whatsnew.bugfix.t": "Bug fixes",
    "whatsnew.bugfix.b": "Small fixes and tidying behind the scenes.",
  },
  ar: {
    "hero.title": "اسأل عبر الأرشيف",
    "hero.subtitle":
      "ليست فتوى — بل كلام العلماء أنفسهم، مستخرَجٌ من آلاف الساعات من المحاضرات والمناظرات، ومتتبَّعٌ إلى اللحظة التي قيل فيها، مع توقيتٍ يمكنك فتحه على الفيديو.",
    "hero.videos": "مقطع",
    "hero.moments": "لحظة قابلة للبحث",
    "hero.channels": "قناة",
    "hero.try": "جرّب أحد هذه الأسئلة",

    "ex.1": "ما المعتقد الصحيح في أسماء الله وصفاته؟",
    "ex.2": "هل يصح الوضوء بماء البحر؟",
    "ex.3": "كيف يرد العلماء على يوحنا ١:١، «وكان الكلمة الله»؟",

    "ask.placeholder": "اسأل أيّ شيء…  (بالعربية أو الإنجليزية)",
    "ask.submit": "اسأل",
    "controls.pickChannel": "اختر قناة",
    "controls.pickOne": "اختر قناة واحدة على الأقل.",
    "controls.channelCount": "{n} قناة",
    "controls.perAnswer": "≈ {price} لكل إجابة",
    "style.topical": "موضوعي",
    "style.verbatim": "حرفي",
    "style.disclaimer": "إجابة موضوعية — صاغها الذكاء الاصطناعي من كلام العلماء. قد تقع أخطاء والترجمات تقريبية، فراجِع المصادر الأصلية.",

    "stage.1": "نُحلّل سؤالك إلى زوايا",
    "stage.2": "نبحث في مليون لحظة",
    "stage.3": "نقرأ أكثرها صلة",
    "stage.4": "نكتب إجابةً موثّقة",
    "loading.note": "الإجابة الدقيقة تستغرق لحظات.",

    "answer.skip": "انتقل إلى المقاطع",
    "answer.findingVideos": "جارٍ إيجاد المقاطع",
    "answer.cost": "كلفة هذه الإجابة {cost}",
    "answer.coverage": "اعتمدت على {moments} لحظة من {videos} مقطعًا",
    "answer.cited": " · استشهدت بـ {n} من {channels} قناة",
    "answer.empty": "لم يُطابِق هذا السؤال شيئًا. جرّب كلماتٍ أخرى، أو أعد صياغته.",
    "sources.title": "المصادر",
    "source.read": "اقرأ النص",
    "source.hide": "أخفِ النص",
    "source.open": "افتح هذه اللحظة على يوتيوب",
    "source.download": "نزّل النص الكامل",
    "source.dlError": "تعذّر تحميل النص. حاول مرة أخرى.",
    "quote.quran": "القرآن",
    "quote.matchesQuran": "يطابق هذا المقطع هذه الآيات",
    "quote.matchesHadith": "يطابق هذا المقطع هذا الحديث",
    "quote.full": "اعرض الحديث كاملًا",
    "quote.less": "اعرض أقل",
    "quote.grade": "الحكم",
    "quote.alsoIn": "وورد أيضًا في",
    "quote.note": "طُوبق تلقائيًا من كلمات الدرس.",
    "quote.quranSource": "النص:",
    "quote.hadithSource": "النص:",
    "cite.loading": "الإجابة ما زالت قيد التحميل — ستظهر المصادر في الأسفل بعد لحظات.",
    "cite.missing": "هذا المصدر غير متاح.",

    "sidebar.new": "سؤال جديد",
    "sidebar.empty": "تُحفظ أسئلتك هنا عند طرحها.",
    "sidebar.theme": "المظهر",
    "sidebar.admin": "الإدارة",
    "sidebar.answersToday": "{used}/{cap} إجابة اليوم",
    "aria.signout": "تسجيل الخروج",
    "aria.collapse": "طيّ القائمة",
    "aria.openMenu": "فتح القائمة",
    "aria.deleteQuestion": "حذف السؤال",
    "footer.privacy": "الخصوصية",
    "footer.terms": "الشروط",

    "err.signInAgain": "يرجى تسجيل الدخول من جديد.",
    "err.server": "تعذّر الوصول إلى الخادم.",
    "err.generic": "حدث خطأٌ ما.",
    "err.interrupted": "انقطعت الإجابة قبل أن تكتمل. أعد طرح السؤال من فضلك.",

    "signin.welcome": "مرحبًا بعودتك",
    "signin.createTitle": "أنشئ حسابك",
    "signin.tagline": "كلام العلماء أنفسهم، متتبَّعٌ إلى اللحظة التي قيل فيها.",
    "signin.google": "المتابعة عبر Google",
    "signin.or": "أو",
    "signin.email": "البريد الإلكتروني",
    "signin.password": "كلمة المرور",
    "signin.signIn": "تسجيل الدخول",
    "signin.create": "إنشاء حساب",
    "signin.newHere": "جديد هنا؟ ",
    "signin.createOne": "أنشئ حسابًا",
    "signin.haveAccount": "لديك حساب بالفعل؟ ",
    "signin.signInShort": "سجّل الدخول",
    "signin.agree": "بالمتابعة فإنك توافق على {terms} و{privacy}.",
    "signin.terms": "الشروط",
    "signin.privacy": "سياسة الخصوصية",
    "signin.err.wrong": "البريد أو كلمة المرور غير صحيحة.",
    "signin.err.inUse": "هذا البريد له حساب بالفعل — جرّب تسجيل الدخول.",
    "signin.err.weak": "ينبغي أن تكون كلمة المرور 6 أحرف على الأقل.",
    "signin.err.invalidEmail": "لا يبدو هذا بريدًا صحيحًا.",
    "signin.err.tooMany": "محاولاتٌ كثيرة — انتظر قليلًا ثم أعد المحاولة.",
    "signin.err.generic": "حدث خطأٌ ما. يرجى المحاولة مجددًا.",
    "signin.guest": "المتابعة كزائر",
    "signin.guestHint": "سؤالان، دون حاجة إلى حساب.",
    "signin.err.guestOff": "وضع الزائر غير متاح حاليًا.",
    "guest.label": "زائر",
    "guest.usage": "{used}/{cap} سؤال مجاني",
    "guest.prompt.title": "انتهت أسئلتك المجانية",
    "guest.prompt.body": "أنشئ حسابًا مجانيًا أو سجّل الدخول لمواصلة السؤال — مجانًا.",
    "guest.prompt.create": "إنشاء حساب مجاني",
    "guest.prompt.signin": "تسجيل الدخول",

    "admin.tab.accounts": "الحسابات",
    "admin.tab.channels": "القنوات",
    "admin.close": "إغلاق",
    "admin.accounts.help": "الحد اليومي للإجابات لكل حساب (فارغ = الافتراضي {cap}).",
    "admin.accounts.helpChannels": " وسّع حسابًا لإظهار القنوات المخفية له وحده.",
    "admin.loading": "جارٍ التحميل…",
    "admin.noAccounts": "لا حسابات بعد.",
    "admin.save": "حفظ",
    "admin.today": "{used}/{cap} اليوم",
    "admin.default": " · افتراضي",
    "admin.channelAccess": "الوصول إلى القنوات",
    "admin.shownCount": " · {n} ظاهرة",
    "admin.shown": "ظاهرة",
    "admin.hidden": "مخفية",
    "admin.visible": "ظاهرة",
    "admin.saveAccess": "حفظ الوصول",
    "admin.channels.help": "اضبط اسم كل قناة بالإنجليزية والعربية، وأخفِ ما لا تريد ظهوره للحسابات غير الإدارية (المخفية لا تظهر في المنتقي ولا تُدرَج في إجاباتها).",
    "admin.channels.enName": "الاسم بالإنجليزية",
    "admin.channels.arName": "الاسم بالعربية",
    "admin.noChannels": "لا قنوات بعد.",
    "admin.saveChanges": "حفظ التغييرات",
    "admin.saving": "جارٍ الحفظ…",
    "admin.couldntLoadAccounts": "تعذّر تحميل الحسابات.",
    "admin.couldntLoadChannels": "تعذّر تحميل القنوات.",
    "admin.couldntReach": "تعذّر الوصول إلى الخادم.",

    "whatsnew.title": "ما الجديد",
    "whatsnew.dismiss": "تمام",
    "whatsnew.history.t": "سجلّ أسئلتك",
    "whatsnew.history.b": "كل سؤال تطرحه يُحفَظ الآن في القائمة الجانبية — افتح أيًّا منها متى شئت.",
    "whatsnew.arabic.t": "واجهة عربية",
    "whatsnew.arabic.b": "بدّل التطبيق كله بين الإنجليزية والعربية من الزرّ في الأعلى.",
    "whatsnew.answers.t": "إجابات أكثر سلاسة",
    "whatsnew.answers.b": "تظهر الإجابات الآن بسلاسة أكبر وتُقرأ بوضوح أكثر.",
    "whatsnew.verbatim.t": "الوضع الحرفي",
    "whatsnew.verbatim.b": "مبدِّل جديد موضوعي / حرفي — اقرأ كلام العلماء بنصّه في لغته الأصلية، أو ملخّصًا مُصاغًا.",
    "whatsnew.whosaid.t": "مَن قال ماذا",
    "whatsnew.whosaid.b": "تنسب الإجابات الآن كل نقطة إلى قناتها وتُبقي الآراء المختلفة جنبًا إلى جنب — ما قيل، لا حُكمًا واحدًا مُدمَجًا.",
    "whatsnew.comprehensive.t": "إجابات أوفى وأعمق",
    "whatsnew.comprehensive.b": "تعرض الإجابات الآن موقف كل قناة بالتفصيل، بعناوين واقتباسات — وإن نوقشت المسألة في مواضع كثيرة حصلت عليها كلها، لا عيّنة منها.",
    "whatsnew.download.t": "تنزيل النصوص",
    "whatsnew.download.b": "لكل مصدر الآن زرّ تنزيل لنصّ ذلك المقطع كاملًا.",
    "whatsnew.resume.t": "الإجابة تكتمل وإن غادرت",
    "whatsnew.resume.b": "انتقل إلى تطبيق آخر أو اقفل هاتفك أثناء الإجابة — تستمر كتابتها، وتجدها كاملة حين تعود.",
    "whatsnew.quotes.t": "عزو الآيات والأحاديث",
    "whatsnew.quotes.b": "حين يتلو العالم آيةً أو يروي حديثًا، يبيّن المصدر الآن ما يطابقه — الآية بالرسم العثماني، أو الحديث بكتابه ورقمه وحكمه. للدروس العربية حاليًا.",
    "whatsnew.fixes.t": "إصلاحات صغيرة",
    "whatsnew.fixes.b": "ضبط محاذاة الإجابة عند خلط الإنجليزية والعربية، مع تحسينات طفيفة أخرى.",

    "mode.custom": "مخصّص",
    "custom.title": "عمق مخصّص — للمشرف",
    "custom.upto": "حتى ≈ {price}",
    "custom.moments.label": "عدد اللحظات",
    "custom.moments.unit": "لحظة",
    "custom.moments.help": "كم لحظةً من النصوص يقرؤها النموذج. الأكثر = تغطية أوسع — لكن بعد ~1000–2000 تزيد التكلفة والضوضاء غالبًا لا التغطية: الصلة تنفد قبل أن ينفد الرقم.",
    "custom.tokens.label": "طول الإجابة",
    "custom.tokens.unit": "رمز",
    "custom.tokens.help": "أقصى ما قد تكتبه الإجابة (الرمز ≈ ثلاثة أرباع كلمة). سقفٌ لا هدف — رفعه لا يُطيل إجابةً قصيرة، بل يُتيح الطويلة فقط. ~16 ألفًا ≈ 12 ألف كلمة؛ الحدّ 32 ألفًا.",
    "custom.note": "هذا تقدير أعلى — الإجابة أقل كلفةً عادةً، إذ تتوقف متى قالت كل ما يتّصل بالسؤال. التكلفة الحقيقية تظهر مع كل إجابة.",
    "channels.selectAll": "تحديد الكل",
    "channels.deselectAll": "إلغاء تحديد الكل",
    "channels.clear": "مسح",
    "admin.defaultCapLabel": "الحد اليومي الافتراضي (للجميع):",
    "whatsnew.polish.t": "إصلاحات صغيرة أخرى",
    "whatsnew.polish.b": "تحتفظ الإجابات المحفوظة بنمطها، وحذف المحادثة أسهل على الجوال، ويمكنك تحديد كل القنوات أو إلغاء تحديدها بنقرة واحدة.",
    "whatsnew.bugfix.t": "إصلاحات",
    "whatsnew.bugfix.b": "إصلاحات صغيرة وتحسينات خلف الكواليس.",
  },
};

type I18n = {
  lang: Lang;
  dir: "ltr" | "rtl";
  setLang: (l: Lang) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
};

const Ctx = createContext<I18n>({ lang: "en", dir: "ltr", setLang: () => {}, t: (k) => k });

function translate(lang: Lang, key: string, params?: Record<string, string | number>): string {
  let s = DICT[lang][key] ?? DICT.en[key] ?? key;
  if (params) for (const k of Object.keys(params)) s = s.split(`{${k}}`).join(String(params[k]));
  return s;
}

export function LangProvider({ children }: { children: ReactNode }) {
  // Start "en" on both server and first client render (no hydration mismatch); switch to the saved
  // language right after mount.
  const [lang, setLangState] = useState<Lang>("en");

  useEffect(() => {
    try {
      const v = localStorage.getItem("lang");
      if (v === "ar") setLangState("ar");
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    const el = document.documentElement;
    el.setAttribute("lang", lang);
    el.setAttribute("dir", lang === "ar" ? "rtl" : "ltr");
  }, [lang]);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem("lang", l);
    } catch {
      /* ignore */
    }
  }, []);

  const t = useCallback((key: string, params?: Record<string, string | number>) => translate(lang, key, params), [lang]);

  return <Ctx.Provider value={{ lang, dir: lang === "ar" ? "rtl" : "ltr", setLang, t }}>{children}</Ctx.Provider>;
}

export const useLang = () => useContext(Ctx);

// A small EN / عر toggle with a sliding highlight. Kept LTR internally so the slide is consistent.
export function LangToggle() {
  const { lang, setLang } = useLang();
  return (
    <div
      dir="ltr"
      className="relative inline-flex items-center rounded-full border border-line bg-raised/70 p-0.5 text-[12px] leading-none"
    >
      <span
        className={`absolute top-0.5 bottom-0.5 left-0.5 w-[34px] rounded-full bg-accent/12 transition-transform duration-300 ease-[cubic-bezier(0.2,0.7,0.2,1)] ${
          lang === "ar" ? "translate-x-[34px]" : "translate-x-0"
        }`}
        aria-hidden
      />
      <button
        type="button"
        onClick={() => setLang("en")}
        aria-pressed={lang === "en"}
        className={`relative z-10 w-[34px] rounded-full py-1 text-center transition-colors ${
          lang === "en" ? "font-medium text-accent" : "text-faint hover:text-muted"
        }`}
      >
        EN
      </button>
      <button
        type="button"
        onClick={() => setLang("ar")}
        aria-pressed={lang === "ar"}
        className={`relative z-10 w-[34px] rounded-full py-1 text-center transition-colors ${
          lang === "ar" ? "font-medium text-accent" : "text-faint hover:text-muted"
        }`}
      >
        عر
      </button>
    </div>
  );
}
