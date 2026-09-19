import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { enUS, ar } from 'date-fns/locale';
import type { Locale } from 'date-fns';

export type Language = 'en' | 'ar';

const en = {
  appName: 'ChatApp',
  signInToContinue: 'Sign in to continue',
  createYourAccount: 'Create your account',
  username: 'Username',
  enterUsername: 'Enter username',
  displayName: 'Display Name',
  yourName: 'Your name',
  password: 'Password',
  enterPassword: 'Enter password',
  pleaseWait: 'Please wait...',
  signIn: 'Sign In',
  createAccount: 'Create Account',
  noAccount: "Don't have an account? ",
  haveAccount: 'Already have an account? ',
  signUp: 'Sign up',
  chats: 'Chats',
  newChat: 'New chat',
  newGroup: 'New group',
  toggleTheme: 'Toggle theme',
  logout: 'Logout',
  language: 'Language',
  searchOrStart: 'Search or start new chat',
  yesterday: 'Yesterday',
  today: 'Today',
  photo: 'Photo',
  file: 'File',
  noMessagesYet: 'No messages yet',
  noConversationsFound: 'No conversations found',
  noConversationsYet: 'No conversations yet. Start a new chat!',
  groupChat: 'Group Chat',
  chat: 'Chat',
  selectConversation: 'Select a conversation or start a new chat',
  callFailed: 'Call failed: {reason}',
  members: '{count} members',
  online: 'online',
  lastSeen: 'last seen {time}',
  whiteboard: 'Whiteboard',
  voiceCall: 'Voice call',
  videoCall: 'Video call',
  isTyping: '{names} is typing...',
  areTyping: '{names} are typing...',
  editingMessage: 'Editing message',
  typeAMessage: 'Type a message',
  messageDeleted: 'This message was deleted',
  sharedImage: 'Shared image',
  edited: 'edited',
  reply: 'Reply',
  edit: 'Edit',
  delete: 'Delete',
  todayAt: 'today at {time}',
  yesterdayAt: 'yesterday at {time}',
  groupName: 'Group name',
  searchUsers: 'Search users...',
  createGroup: 'Create Group ({count} members)',
  ringing: 'Ringing...',
  connecting: 'Connecting...',
  callEnded: 'Call ended',
  unmute: 'Unmute',
  mute: 'Mute',
  turnOnCamera: 'Turn on camera',
  turnOffCamera: 'Turn off camera',
  endCall: 'End call',
  incomingCall: 'Incoming {type} call...',
  audio: 'audio',
  video: 'video',
  accept: 'Accept',
  reject: 'Reject',
  joinVoice: 'Join Voice',
  voiceOn: 'Voice On',
  muted: 'Muted',
  leaveVoice: 'Leave voice',
  end: 'End',
  leave: 'Leave',
  inCall: 'In call · {count}',
  you: 'You',
  uploadPdfPrompt: 'Upload a PDF to get started, or draw on the blank canvas',
  waitingForPresenter: 'Waiting for presenter...',
  pdfLoadError: 'Failed to load the PDF. Please try uploading it again.',
  uploading: 'Uploading',
  processing: 'Processing…',
  pen: 'Pen',
  eraser: 'Eraser',
  clearPage: 'Clear page',
  uploadPdf: 'Upload PDF',
  errNoToken: 'No token provided',
  errInvalidToken: 'Invalid token',
  errAllFieldsRequired: 'All fields are required',
  errUsernameLength: 'Username must be 3-20 characters',
  errPasswordLength: 'Password must be at least 6 characters',
  errUsernameTaken: 'Username already taken',
  errUsernamePasswordRequired: 'Username and password are required',
  errInvalidCredentials: 'Invalid credentials',
  errUserNotFound: 'User not found',
  errDirectMember: 'Direct conversation needs exactly one other member',
  errNotMember: 'Not a member',
  errNoFile: 'No file uploaded',
  errUserOffline: 'User is offline',
};

const ar_: typeof en = {
  appName: 'تطبيق الدردشة',
  signInToContinue: 'سجّل الدخول للمتابعة',
  createYourAccount: 'أنشئ حسابك',
  username: 'اسم المستخدم',
  enterUsername: 'أدخل اسم المستخدم',
  displayName: 'الاسم المعروض',
  yourName: 'اسمك',
  password: 'كلمة المرور',
  enterPassword: 'أدخل كلمة المرور',
  pleaseWait: 'يرجى الانتظار...',
  signIn: 'تسجيل الدخول',
  createAccount: 'إنشاء حساب',
  noAccount: 'ليس لديك حساب؟ ',
  haveAccount: 'لديك حساب بالفعل؟ ',
  signUp: 'إنشاء حساب',
  chats: 'المحادثات',
  newChat: 'محادثة جديدة',
  newGroup: 'مجموعة جديدة',
  toggleTheme: 'تبديل المظهر',
  logout: 'تسجيل الخروج',
  language: 'اللغة',
  searchOrStart: 'ابحث أو ابدأ محادثة جديدة',
  yesterday: 'أمس',
  today: 'اليوم',
  photo: 'صورة',
  file: 'ملف',
  noMessagesYet: 'لا توجد رسائل بعد',
  noConversationsFound: 'لا توجد محادثات',
  noConversationsYet: 'لا توجد محادثات بعد. ابدأ محادثة جديدة!',
  groupChat: 'محادثة جماعية',
  chat: 'محادثة',
  selectConversation: 'اختر محادثة أو ابدأ محادثة جديدة',
  callFailed: 'فشلت المكالمة: {reason}',
  members: '{count} أعضاء',
  online: 'متصل',
  lastSeen: 'آخر ظهور {time}',
  whiteboard: 'السبورة',
  voiceCall: 'مكالمة صوتية',
  videoCall: 'مكالمة فيديو',
  isTyping: '{names} يكتب...',
  areTyping: '{names} يكتبون...',
  editingMessage: 'تعديل الرسالة',
  typeAMessage: 'اكتب رسالة',
  messageDeleted: 'تم حذف هذه الرسالة',
  sharedImage: 'صورة مشتركة',
  edited: 'تم التعديل',
  reply: 'رد',
  edit: 'تعديل',
  delete: 'حذف',
  todayAt: 'اليوم الساعة {time}',
  yesterdayAt: 'أمس الساعة {time}',
  groupName: 'اسم المجموعة',
  searchUsers: 'ابحث عن مستخدمين...',
  createGroup: 'إنشاء مجموعة ({count} أعضاء)',
  ringing: 'جارٍ الرنين...',
  connecting: 'جارٍ الاتصال...',
  callEnded: 'انتهت المكالمة',
  unmute: 'إلغاء الكتم',
  mute: 'كتم',
  turnOnCamera: 'تشغيل الكاميرا',
  turnOffCamera: 'إيقاف الكاميرا',
  endCall: 'إنهاء المكالمة',
  incomingCall: 'مكالمة {type} واردة...',
  audio: 'صوتية',
  video: 'فيديو',
  accept: 'قبول',
  reject: 'رفض',
  joinVoice: 'الانضمام للصوت',
  voiceOn: 'الصوت مفعّل',
  muted: 'مكتوم',
  leaveVoice: 'مغادرة الصوت',
  end: 'إنهاء',
  leave: 'مغادرة',
  inCall: 'في المكالمة · {count}',
  you: 'أنت',
  uploadPdfPrompt: 'ارفع ملف PDF للبدء، أو ارسم على اللوحة الفارغة',
  waitingForPresenter: 'في انتظار العارض...',
  pdfLoadError: 'تعذّر تحميل ملف PDF. يرجى محاولة رفعه مرة أخرى.',
  uploading: 'جارٍ الرفع',
  processing: 'جارٍ المعالجة…',
  pen: 'قلم',
  eraser: 'ممحاة',
  clearPage: 'مسح الصفحة',
  uploadPdf: 'رفع PDF',
  errNoToken: 'لا يوجد رمز دخول',
  errInvalidToken: 'رمز الدخول غير صالح',
  errAllFieldsRequired: 'جميع الحقول مطلوبة',
  errUsernameLength: 'يجب أن يكون اسم المستخدم بين 3 و 20 حرفًا',
  errPasswordLength: 'يجب أن تكون كلمة المرور 6 أحرف على الأقل',
  errUsernameTaken: 'اسم المستخدم مأخوذ بالفعل',
  errUsernamePasswordRequired: 'اسم المستخدم وكلمة المرور مطلوبان',
  errInvalidCredentials: 'بيانات الدخول غير صحيحة',
  errUserNotFound: 'المستخدم غير موجود',
  errDirectMember: 'المحادثة المباشرة تتطلب عضوًا آخر واحدًا بالضبط',
  errNotMember: 'لست عضوًا في هذه المحادثة',
  errNoFile: 'لم يتم رفع أي ملف',
  errUserOffline: 'المستخدم غير متصل',
};

const translations: Record<Language, typeof en> = { en, ar: ar_ };

export type TranslationKey = keyof typeof en;

const ERROR_KEY_MAP: Record<string, TranslationKey> = {
  'No token provided': 'errNoToken',
  'Invalid token': 'errInvalidToken',
  'All fields are required': 'errAllFieldsRequired',
  'Username must be 3-20 characters': 'errUsernameLength',
  'Password must be at least 6 characters': 'errPasswordLength',
  'Username already taken': 'errUsernameTaken',
  'Username and password are required': 'errUsernamePasswordRequired',
  'Invalid credentials': 'errInvalidCredentials',
  'User not found': 'errUserNotFound',
  'Direct conversation needs exactly one other member': 'errDirectMember',
  'Not a member': 'errNotMember',
  'No file uploaded': 'errNoFile',
  'User is offline': 'errUserOffline',
};

interface I18nContextValue {
  lang: Language;
  dir: 'ltr' | 'rtl';
  dateLocale: Locale;
  setLang: (lang: Language) => void;
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
  translateError: (raw: string) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Language>(() => {
    const stored = localStorage.getItem('lang');
    return stored === 'ar' || stored === 'en' ? stored : 'en';
  });

  const dir: 'ltr' | 'rtl' = lang === 'ar' ? 'rtl' : 'ltr';

  useEffect(() => {
    document.documentElement.setAttribute('lang', lang);
    document.documentElement.setAttribute('dir', dir);
    localStorage.setItem('lang', lang);
  }, [lang, dir]);

  function t(key: TranslationKey, vars?: Record<string, string | number>) {
    let str = translations[lang][key] ?? translations.en[key] ?? key;
    if (vars) {
      for (const [name, value] of Object.entries(vars)) {
        str = str.replace(new RegExp(`\\{${name}\\}`, 'g'), String(value));
      }
    }
    return str;
  }

  function translateError(raw: string) {
    const key = ERROR_KEY_MAP[raw];
    return key ? t(key) : raw;
  }

  return (
    <I18nContext.Provider
      value={{ lang, dir, dateLocale: lang === 'ar' ? ar : enUS, setLang, t, translateError }}
    >
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used within an I18nProvider');
  return ctx;
}
