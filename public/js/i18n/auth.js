// Arabic for the authentication and account-recovery journey, plus the two
// verification landings and the 404 page.
//
// One file for these seven pages because they are small and share a vocabulary:
// a member moving between sign-in, sign-up and password recovery should not
// meet three different words for "password".
//
// STATUS: machine-drafted Modern Standard Arabic, PENDING NATIVE REVIEW. See
// docs/ARABIC_RTL.md. Nothing here is legal copy.
register({
  en: {
    'login.signInNaseeb': 'Sign in — Naseeb',
    'login.welcomeBack': 'Welcome back.',
    'login.forgotYourPassword': 'Forgot your password?',

    'signup.joinNaseeb': 'Join Naseeb',
    'signup.takesAMinuteNo': 'Takes a minute. No payment details, ever.',
    'signup.iConfirmThatI': 'I confirm that I am 18 years of age or older.',
    'signup.thisIsYourOwn': 'This is your own declaration. We do not ask for your date of birth or any identity document, and we cannot verify it.',
    'signup.createAccount': 'Create account',

    'forgotpassword.resetYourPasswordNaseeb': 'Reset your password — Naseeb',
    'forgotpassword.resetYourPassword': 'Reset your password',
    'forgotpassword.weLlEmailYou': "We'll email you a link to set a new one.",
    'forgotpassword.sendResetLink': 'Send reset link',
    'forgotpassword.backToSignIn': 'Back to sign in',

    'resetpassword.setANewPassword': 'Set a new password — Naseeb',
    'resetpassword.setANewPassword2': 'Set a new password',
    'resetpassword.makeItSomethingYou': "Make it something you haven't used elsewhere.",
    'resetpassword.newPassword': 'New password',
    'resetpassword.setNewPassword': 'Set new password',
    'resetpassword.passwordUpdated': 'Password updated.',
    'resetpassword.youCanSignIn': 'You can sign in with your new password now.',

    'verify.verifyYourEmailNaseeb': 'Verify your email — Naseeb',
    'verify.verifying': 'Verifying…',

    'verifyemailchange.confirmYourNewEmail': 'Confirm your new email — Naseeb',
    'verifyemailchange.checkingYourLink': 'Checking your link…',

    '404.pageNotFoundNaseeb': 'Page not found — Naseeb',
    '404.thisTicketDoesnT': "This ticket doesn't exist.",
    '404.thePageYouRe': "The page you're looking for isn't here — it may have been moved, or the giveaway may have ended.",
    '404.backToOpenGiveaways': 'Back to open giveaways',
  },
  ar: {
    'login.signInNaseeb': 'تسجيل الدخول — نصيب',
    'login.welcomeBack': 'أهلًا بعودتك.',
    'login.forgotYourPassword': 'هل نسيت كلمة المرور؟',

    'signup.joinNaseeb': 'انضم إلى نصيب',
    'signup.takesAMinuteNo': 'لا يستغرق سوى دقيقة. ولا نطلب بيانات دفع إطلاقًا.',
    'signup.iConfirmThatI': 'أُقِرّ بأن عمري ١٨ عامًا أو أكثر.',
    'signup.thisIsYourOwn': 'هذا إقرار منك أنت. نحن لا نطلب تاريخ ميلادك ولا أي وثيقة هوية، ولا يمكننا التحقق منه.',
    'signup.createAccount': 'إنشاء حساب',

    'forgotpassword.resetYourPasswordNaseeb': 'إعادة تعيين كلمة المرور — نصيب',
    'forgotpassword.resetYourPassword': 'إعادة تعيين كلمة المرور',
    'forgotpassword.weLlEmailYou': 'سنرسل إليك رابطًا عبر البريد الإلكتروني لتعيين كلمة مرور جديدة.',
    'forgotpassword.sendResetLink': 'إرسال رابط إعادة التعيين',
    'forgotpassword.backToSignIn': 'العودة إلى تسجيل الدخول',

    'resetpassword.setANewPassword': 'تعيين كلمة مرور جديدة — نصيب',
    'resetpassword.setANewPassword2': 'تعيين كلمة مرور جديدة',
    'resetpassword.makeItSomethingYou': 'اختر كلمة مرور لم تستخدمها في أي مكان آخر.',
    'resetpassword.newPassword': 'كلمة المرور الجديدة',
    'resetpassword.setNewPassword': 'تعيين كلمة المرور',
    'resetpassword.passwordUpdated': 'تم تحديث كلمة المرور.',
    'resetpassword.youCanSignIn': 'يمكنك الآن تسجيل الدخول بكلمة المرور الجديدة.',

    'verify.verifyYourEmailNaseeb': 'تأكيد بريدك الإلكتروني — نصيب',
    'verify.verifying': 'جارٍ التحقق…',

    'verifyemailchange.confirmYourNewEmail': 'تأكيد بريدك الإلكتروني الجديد — نصيب',
    'verifyemailchange.checkingYourLink': 'جارٍ التحقق من الرابط…',

    '404.pageNotFoundNaseeb': 'الصفحة غير موجودة — نصيب',
    '404.thisTicketDoesnT': 'هذه التذكرة غير موجودة.',
    '404.thePageYouRe': 'الصفحة التي تبحث عنها ليست هنا — ربما نُقلت، أو ربما انتهت المسابقة.',
    '404.backToOpenGiveaways': 'العودة إلى المسابقات المفتوحة',
  },
});
