// Arabic for the messages the server sends back when something is refused.
//
// ---------------------------------------------------------------------------
// Why these are translated here and not on the server
// ---------------------------------------------------------------------------
//
// Every page could be fully translated and still show English the moment
// anything went wrong, because the sentence a person reads after a failed form
// submission is not written on the page — it arrives in a JSON response. That is
// the half of a product people meet when they are already frustrated, and it is
// the half most likely to be left in one language.
//
// The server keeps writing them in English. It has no idea who is asking: the
// same response goes to a browser, to a test, and to the operations scripts, and
// making it negotiate a language per request would put a display concern into
// the layer that decides whether an action is allowed. So the API stays the
// authority on WHAT happened, and the page decides HOW to say it — api() looks
// the message up here and falls back to the server's own words when there is no
// entry.
//
// The lookup is an explicit map from the exact English sentence rather than a
// slug derived from it. Derived slugs collide: "A short reason is required."
// and "A short reason is required for a rescue action." share their first four
// words and would silently become one entry, showing a reader the wrong reason
// for a refusal. test/server-error-i18n.test.js reads every error literal out of
// server/ and fails when one has no entry here, so a new refusal cannot be added
// in English only.
//
// Two of these are deliberately not user-facing — a webhook signature failure
// and an unconfigured webhook are addressed to Stripe and to whoever deployed
// this — but they are translated anyway rather than special-cased, because
// deciding which errors a person can reach is exactly the judgement that goes
// stale.
//
// STATUS: machine-drafted Modern Standard Arabic, PENDING NATIVE REVIEW.
register({
  en: {
    'errors.bannerImageRequired': 'A banner image is required.',
    'errors.giveawayRequired': 'A giveaway is required.',
    'errors.reasonRequiredForDelivery': 'A short reason is required before delivery details can be opened.',
    'errors.reasonRequiredForRescue': 'A short reason is required for a rescue action.',
    'errors.reasonRequired': 'A short reason is required.',
    'errors.accountNotFound': 'Account not found.',
    'errors.adNotFound': 'Ad not found.',
    'errors.emailAlreadyExists': 'An account with this email already exists.',
    'errors.applicantTypeInvalid': 'Applicant type must be individual or company.',
    'errors.applicationNotFound': 'Application not found.',
    'errors.bookingNotFound': 'Booking not found.',
    'errors.businessNameRequiredCompany': 'Business name is required for a company application.',
    'errors.businessNameRequired': 'Business name is required.',
    'errors.businessNameTooLong': 'Business name must be 200 characters or fewer.',
    'errors.choosePrizeCategory': 'Choose the prize category that fits best.',
    'errors.couldNotProcessEvent': 'Could not process this event.',
    'errors.deliveryDetailsRequired': 'Delivery details are required.',
    'errors.emailAndPasswordRequired': 'Email and password are required.',
    'errors.nameLengthRange': 'Enter a name between 1 and 100 characters.',
    'errors.estimatedValueInvalid': 'Estimated value must be a non-negative number.',
    'errors.settingsObjectExpected': 'Expected an object of settings to update.',
    'errors.giveGenuineValue': 'Give the genuine retail or market value of the prize in AED.',
    'errors.giveawayNotFound2': 'Giveaway not found.',
    'errors.incorrectCredentials': 'Incorrect email or password.',
    'errors.inquiryNotFound': 'Inquiry not found.',
    'errors.invalidSignature': 'Invalid signature.',
    'errors.maxEntriesInvalid': 'Max entries per person must be a positive whole number.',
    'errors.messageTooLong': 'Message must be 2000 characters or fewer.',
    'errors.missingClaimToken': 'Missing claim token.',
    'errors.missingSessionId': 'Missing session_id.',
    'errors.missingVerificationToken': 'Missing verification token.',
    'errors.nameRequired': 'Name is required.',
    'errors.nameTooLong100': 'Name must be 100 characters or fewer.',
    'errors.nameTooLong200': 'Name must be 200 characters or fewer.',
    'errors.nameEmailPasswordRequired': 'Name, email, and password are all required.',
    'errors.noClaimForGiveaway': 'No claim exists for this giveaway.',
    'errors.notFound': 'Not found.',
    'errors.notReadyForEvent': 'Not ready to process this event yet.',
    'errors.onlyHostCanDraw': 'Only the host of this giveaway can draw a winner.',
    'errors.onlyHostCanFlag': 'Only the host of this giveaway can flag an entry on it.',
    'errors.onlyHostCanManageDelivery': 'Only the host of this giveaway can manage delivery.',
    'errors.passwordTooLong': 'Password must be 72 characters or fewer.',
    'errors.passwordTooShort': 'Password must be at least 8 characters.',
    'errors.phoneTooLong': 'Phone number must be 40 characters or fewer.',
    'errors.invalidEmail': 'Please enter a valid email address.',
    'errors.tryAgainShortly': 'Please try again shortly.',
    'errors.verifyEmailBeforeHosting': 'Please verify your email before applying to host.',
    'errors.verifyEmailBeforeEntering': 'Please verify your email before entering a giveaway.',
    'errors.claimsUnavailable': 'Prize claims are currently unavailable.',
    'errors.claimsTemporarilyUnavailable': 'Prize claims are temporarily unavailable. Please try again shortly.',
    'errors.reasonTooLong': 'Reason must be 1000 characters or fewer.',
    'errors.requestNotFound': 'Request not found.',
    'errors.signInToContinue': 'Sign in to continue.',
    'errors.bookingLookupFailed': 'Something went wrong looking up your booking.',
    'errors.somethingWentWrong': 'Something went wrong. Please try again.',
    'errors.entryDoesNotExist': 'That entry does not exist.',
    'errors.entryNotPartOfGiveaway': 'That entry is not part of this giveaway.',
    'errors.thatGiveawayDoesNotExist': 'That giveaway does not exist.',
    'errors.linkMissingToken': 'That link is missing its token.',
    'errors.expiryNotADate': 'That prize expiry date is not a date.',
    'errors.thatRequestDoesNotExist': 'That request does not exist.',
    'errors.deadlinePassed': 'The closing deadline for this giveaway has passed.',
    'errors.consentWordingUpdated': 'The consent wording has been updated. Please reload the page and read it again.',
    'errors.alreadyApprovedToHost': 'This account is already approved to host.',
    'errors.claimDoesNotExist': 'This claim does not exist.',
    'errors.claimLinkFormatUnsupported': 'This claim link format is no longer supported. Please open the link from your email again.',
    'errors.claimLinkInvalid': 'This claim link is invalid, expired, or already used.',
    'errors.claimLinkInvalid2': 'This claim link is invalid, expired, or has already been used.',
    'errors.giveawayDoesNotExist': 'This giveaway does not exist.',
    'errors.alreadyDrawnCannotChange': 'This giveaway has already been drawn and cannot be changed.',
    'errors.alreadyDrawnOrClosed': 'This giveaway has already been drawn or closed.',
    'errors.requestNotFromNaseeb': 'This request did not come from Naseeb.',
    'errors.resetLinkInvalid': 'This reset link is invalid or has expired. Request a new one.',
    'errors.verificationLinkExpired': 'This verification link has expired. Request a new one from your account.',
    'errors.verificationLinkInvalid': 'This verification link is invalid or has already been used.',
    'errors.tokenAndPasswordRequired': 'Token and new password are required.',
    'errors.tooManyApplications': 'Too many applications submitted. Please try again in a few minutes.',
    'errors.tooManyAttempts': 'Too many attempts. Please try again in a few minutes.',
    'errors.tooManyCheckouts': 'Too many checkout attempts. Please try again in a few minutes.',
    'errors.tooManyInquiries': 'Too many inquiries submitted. Please try again in a few minutes.',
    'errors.tooManyRequests': 'Too many requests. Please slow down and try again shortly.',
    'errors.tradeLicenseTooLong': 'Trade license must be 100 characters or fewer.',
    'errors.userNotFound': 'User not found.',
    'errors.sessionCheckFailed': 'We could not check your session just now. Please try again shortly.',
    'errors.hostingCheckFailed': 'We could not confirm your hosting access just now. Please try again shortly.',
    'errors.requestVerifyFailed': 'We could not verify this request. Please try again shortly.',
    'errors.sessionVerifyFailed': 'We could not verify your session just now. Please try again shortly.',
    'errors.webhookNotConfigured': 'Webhook not configured.',
    'errors.applicationAlreadyWaiting': 'You already have an application waiting for review.',
    'errors.pageOutOfDate': 'Your page is out of date. Reload and try again.',
    'errors.sessionEnded': 'Your session has ended. Sign in again.',
    'errors.sessionExpired': 'Your session has expired. Sign in again.',
    'errors.activeMustBeBoolean': 'active must be true or false.',
    'errors.contactedMustBeBoolean': 'contacted must be true or false.',
    'errors.isVerifiedBusinessMustBeBoolean': 'is_verified_business must be true or false.',
    'errors.enquiryPredatesApproval': "This enquiry predates host approval and is not attached to an account, so no access can be granted from it.",
    'errors.accountDeletionUnavailable': "Deleting an account is not available. Suspend the account to stop abuse, revoke its sessions if it is compromised, or use the privacy request workflow if the account holder has asked to be erased.",
    'errors.onlineBookingUnavailable': "Online booking is temporarily unavailable. Send an inquiry below and we’ll book your slot directly.",
    'errors.adPriceChanged': "The advertising price changed while you were filling this in. Please review the updated total and confirm to continue.",
    'errors.consentRequiredForDelivery': "You need to agree to share your delivery details with the host before we can pass them on.",
    'errors.deliveryPausedUnderReview': "This giveaway is under integrity review. Delivery steps are paused until an administrator resolves it — the winner and this claim are unchanged.",
    'errors.fulfilmentPausedUnderReview': "This giveaway is under integrity review. Fulfilment is paused until an administrator resolves it.",
    'errors.submissionMissingReviewFields': "Naseeb reviews every prize before it is published, and this submission is missing some of what that review needs.",
    'errors.sayWhoHoldsThePrize': "Say who will be holding this prize: Naseeb, the sponsor under a commitment to Naseeb, or the provider who fulfils it.",
    'errors.stillAcceptingEntries': "This giveaway is still accepting entries. It closes on its own at whichever comes first — 100 eligible entries, or the closing deadline — and the draw runs from there without anybody pressing anything.",
    'errors.integrityCheckOpen': "An integrity check is open on this giveaway. Entries are closed and the draw runs automatically once the check is resolved — nothing is lost by waiting.",
    'errors.winnerConfirmsDelivery': "Delivery is now confirmed by the winner, not by the host. Move the claim along from your dashboard — the winner confirms receipt at the end.",
    'errors.suspensionNotLiftedByReapplying': "Hosting access for this account is suspended. Applying again will not lift it — please contact us.",
  },
  ar: {
    'errors.bannerImageRequired': 'صورة اللافتة مطلوبة.',
    'errors.giveawayRequired': 'يجب تحديد مسابقة.',
    'errors.reasonRequiredForDelivery': 'يلزم ذكر سبب موجز قبل فتح بيانات التسليم.',
    'errors.reasonRequiredForRescue': 'يلزم ذكر سبب موجز لإجراء الإنقاذ.',
    'errors.reasonRequired': 'يلزم ذكر سبب موجز.',
    'errors.accountNotFound': 'الحساب غير موجود.',
    'errors.adNotFound': 'الإعلان غير موجود.',
    'errors.emailAlreadyExists': 'يوجد حساب مسجَّل بهذا البريد الإلكتروني بالفعل.',
    'errors.applicantTypeInvalid': 'يجب أن تكون صفة مقدّم الطلب: فرد أو شركة.',
    'errors.applicationNotFound': 'الطلب غير موجود.',
    'errors.bookingNotFound': 'الحجز غير موجود.',
    'errors.businessNameRequiredCompany': 'اسم النشاط التجاري مطلوب لطلبات الشركات.',
    'errors.businessNameRequired': 'اسم النشاط التجاري مطلوب.',
    'errors.businessNameTooLong': 'يجب ألّا يتجاوز اسم النشاط التجاري ٢٠٠ حرف.',
    'errors.choosePrizeCategory': 'اختر فئة الجائزة الأنسب.',
    'errors.couldNotProcessEvent': 'تعذّرت معالجة هذا الحدث.',
    'errors.deliveryDetailsRequired': 'بيانات التسليم مطلوبة.',
    'errors.emailAndPasswordRequired': 'البريد الإلكتروني وكلمة المرور مطلوبان.',
    'errors.nameLengthRange': 'أدخل اسمًا بين حرف واحد و١٠٠ حرف.',
    'errors.estimatedValueInvalid': 'يجب أن تكون القيمة التقديرية رقمًا غير سالب.',
    'errors.settingsObjectExpected': 'يُتوقَّع كائن إعدادات لتحديثه.',
    'errors.giveGenuineValue': 'اذكر القيمة الحقيقية للجائزة في السوق أو للبيع بالتجزئة بالدرهم.',
    'errors.giveawayNotFound2': 'المسابقة غير موجودة.',
    'errors.incorrectCredentials': 'البريد الإلكتروني أو كلمة المرور غير صحيحة.',
    'errors.inquiryNotFound': 'الاستفسار غير موجود.',
    'errors.invalidSignature': 'التوقيع غير صالح.',
    'errors.maxEntriesInvalid': 'يجب أن يكون الحد الأقصى للمشاركات لكل شخص عددًا صحيحًا موجبًا.',
    'errors.messageTooLong': 'يجب ألّا تتجاوز الرسالة ٢٠٠٠ حرف.',
    'errors.missingClaimToken': 'رمز المطالبة مفقود.',
    'errors.missingSessionId': 'معرّف الجلسة مفقود.',
    'errors.missingVerificationToken': 'رمز التحقّق مفقود.',
    'errors.nameRequired': 'الاسم مطلوب.',
    'errors.nameTooLong100': 'يجب ألّا يتجاوز الاسم ١٠٠ حرف.',
    'errors.nameTooLong200': 'يجب ألّا يتجاوز الاسم ٢٠٠ حرف.',
    'errors.nameEmailPasswordRequired': 'الاسم والبريد الإلكتروني وكلمة المرور مطلوبة جميعًا.',
    'errors.noClaimForGiveaway': 'لا توجد مطالبة لهذه المسابقة.',
    'errors.notFound': 'غير موجود.',
    'errors.notReadyForEvent': 'لم يحن وقت معالجة هذا الحدث بعد.',
    'errors.onlyHostCanDraw': 'لا يستطيع سحب الفائز إلا مضيف هذه المسابقة.',
    'errors.onlyHostCanFlag': 'لا يستطيع الإبلاغ عن مشاركة فيها إلا مضيف هذه المسابقة.',
    'errors.onlyHostCanManageDelivery': 'لا يستطيع إدارة التسليم إلا مضيف هذه المسابقة.',
    'errors.passwordTooLong': 'يجب ألّا تتجاوز كلمة المرور ٧٢ حرفًا.',
    'errors.passwordTooShort': 'يجب ألّا تقلّ كلمة المرور عن ٨ أحرف.',
    'errors.phoneTooLong': 'يجب ألّا يتجاوز رقم الهاتف ٤٠ حرفًا.',
    'errors.invalidEmail': 'يُرجى إدخال بريد إلكتروني صحيح.',
    'errors.tryAgainShortly': 'يُرجى المحاولة مجددًا بعد قليل.',
    'errors.verifyEmailBeforeHosting': 'يُرجى توثيق بريدك الإلكتروني قبل التقدّم للاستضافة.',
    'errors.verifyEmailBeforeEntering': 'يُرجى توثيق بريدك الإلكتروني قبل المشاركة في مسابقة.',
    'errors.claimsUnavailable': 'المطالبة بالجوائز غير متاحة حاليًّا.',
    'errors.claimsTemporarilyUnavailable': 'المطالبة بالجوائز غير متاحة مؤقتًا. يُرجى المحاولة مجددًا بعد قليل.',
    'errors.reasonTooLong': 'يجب ألّا يتجاوز السبب ١٠٠٠ حرف.',
    'errors.requestNotFound': 'الطلب غير موجود.',
    'errors.signInToContinue': 'سجّل الدخول للمتابعة.',
    'errors.bookingLookupFailed': 'حدث خطأ أثناء البحث عن حجزك.',
    'errors.somethingWentWrong': 'حدث خطأ ما. يُرجى المحاولة مجددًا.',
    'errors.entryDoesNotExist': 'هذه المشاركة غير موجودة.',
    'errors.entryNotPartOfGiveaway': 'هذه المشاركة ليست ضمن هذه المسابقة.',
    'errors.thatGiveawayDoesNotExist': 'هذه المسابقة غير موجودة.',
    'errors.linkMissingToken': 'هذا الرابط ينقصه الرمز.',
    'errors.expiryNotADate': 'تاريخ انتهاء صلاحية الجائزة ليس تاريخًا صحيحًا.',
    'errors.thatRequestDoesNotExist': 'هذا الطلب غير موجود.',
    'errors.deadlinePassed': 'انقضى أجل إغلاق هذه المسابقة.',
    'errors.consentWordingUpdated': 'تم تحديث نصّ الموافقة. يُرجى إعادة تحميل الصفحة وقراءته مرة أخرى.',
    'errors.alreadyApprovedToHost': 'هذا الحساب معتمَد للاستضافة بالفعل.',
    'errors.claimDoesNotExist': 'هذه المطالبة غير موجودة.',
    'errors.claimLinkFormatUnsupported': 'صيغة رابط المطالبة هذه لم تعد مدعومة. يُرجى فتح الرابط من بريدك مرة أخرى.',
    'errors.claimLinkInvalid': 'رابط المطالبة هذا غير صالح أو منتهي الصلاحية أو مستخدَم من قبل.',
    'errors.claimLinkInvalid2': 'رابط المطالبة هذا غير صالح أو منتهي الصلاحية أو سبق استخدامه.',
    'errors.giveawayDoesNotExist': 'هذه المسابقة غير موجودة.',
    'errors.alreadyDrawnCannotChange': 'سُحب الفائز في هذه المسابقة بالفعل ولا يمكن تغييرها.',
    'errors.alreadyDrawnOrClosed': 'سُحب الفائز في هذه المسابقة أو أُغلقت بالفعل.',
    'errors.requestNotFromNaseeb': 'هذا الطلب لم يصدر من نصيب.',
    'errors.resetLinkInvalid': 'رابط إعادة التعيين هذا غير صالح أو انتهت صلاحيته. اطلب رابطًا جديدًا.',
    'errors.verificationLinkExpired': 'انتهت صلاحية رابط التحقّق هذا. اطلب رابطًا جديدًا من حسابك.',
    'errors.verificationLinkInvalid': 'رابط التحقّق هذا غير صالح أو سبق استخدامه.',
    'errors.tokenAndPasswordRequired': 'الرمز وكلمة المرور الجديدة مطلوبان.',
    'errors.tooManyApplications': 'تم إرسال عدد كبير من الطلبات. يُرجى المحاولة مجددًا بعد بضع دقائق.',
    'errors.tooManyAttempts': 'محاولات كثيرة جدًا. يُرجى المحاولة مجددًا بعد بضع دقائق.',
    'errors.tooManyCheckouts': 'محاولات دفع كثيرة جدًا. يُرجى المحاولة مجددًا بعد بضع دقائق.',
    'errors.tooManyInquiries': 'تم إرسال عدد كبير من الاستفسارات. يُرجى المحاولة مجددًا بعد بضع دقائق.',
    'errors.tooManyRequests': 'طلبات كثيرة جدًا. يُرجى التمهّل والمحاولة مجددًا بعد قليل.',
    'errors.tradeLicenseTooLong': 'يجب ألّا يتجاوز رقم الرخصة التجارية ١٠٠ حرف.',
    'errors.userNotFound': 'المستخدم غير موجود.',
    'errors.sessionCheckFailed': 'تعذّر التحقّق من جلستك الآن. يُرجى المحاولة مجددًا بعد قليل.',
    'errors.hostingCheckFailed': 'تعذّر تأكيد صلاحية الاستضافة الخاصة بك الآن. يُرجى المحاولة مجددًا بعد قليل.',
    'errors.requestVerifyFailed': 'تعذّر التحقّق من هذا الطلب. يُرجى المحاولة مجددًا بعد قليل.',
    'errors.sessionVerifyFailed': 'تعذّر التحقّق من جلستك الآن. يُرجى المحاولة مجددًا بعد قليل.',
    'errors.webhookNotConfigured': 'الخطّاف الشبكي غير مُهيّأ.',
    'errors.applicationAlreadyWaiting': 'لديك طلب في انتظار المراجعة بالفعل.',
    'errors.pageOutOfDate': 'صفحتك قديمة. أعد التحميل وحاول مجددًا.',
    'errors.sessionEnded': 'انتهت جلستك. سجّل الدخول مرة أخرى.',
    'errors.sessionExpired': 'انتهت صلاحية جلستك. سجّل الدخول مرة أخرى.',
    'errors.activeMustBeBoolean': 'يجب أن تكون قيمة active إما true أو false.',
    'errors.contactedMustBeBoolean': 'يجب أن تكون قيمة contacted إما true أو false.',
    'errors.isVerifiedBusinessMustBeBoolean': 'يجب أن تكون قيمة is_verified_business إما true أو false.',
    'errors.enquiryPredatesApproval': "هذا الاستفسار سابق لاعتماد الاستضافة وغير مرتبط بأي حساب، فلا يمكن منح أي صلاحية استنادًا إليه.",
    'errors.accountDeletionUnavailable': "حذف الحساب غير متاح. أوقف الحساب لمنع إساءة الاستخدام، أو ألغِ جلساته إذا كان مخترقًا، أو استخدم مسار طلبات الخصوصية إذا طلب صاحب الحساب محو بياناته.",
    'errors.onlineBookingUnavailable': "الحجز عبر الإنترنت غير متاح مؤقتًا. أرسل استفسارًا أدناه وسنحجز لك المساحة مباشرةً.",
    'errors.adPriceChanged': "تغيّر سعر الإعلان أثناء تعبئتك للنموذج. يُرجى مراجعة الإجمالي المحدَّث والتأكيد للمتابعة.",
    'errors.consentRequiredForDelivery': "عليك الموافقة على مشاركة بيانات التسليم مع المضيف قبل أن نتمكّن من تمريرها إليه.",
    'errors.deliveryPausedUnderReview': "هذه المسابقة قيد مراجعة النزاهة. وخطوات التسليم موقوفة إلى أن يبتّ فيها مشرف — والفائز وهذه المطالبة دون تغيير.",
    'errors.fulfilmentPausedUnderReview': "هذه المسابقة قيد مراجعة النزاهة. والتنفيذ موقوف إلى أن يبتّ فيها مشرف.",
    'errors.submissionMissingReviewFields': "تراجع نصيب كل جائزة قبل نشرها، وينقص هذا الطلب بعض ما تحتاجه تلك المراجعة.",
    'errors.sayWhoHoldsThePrize': "حدّد من سيحوز هذه الجائزة: نصيب، أو الراعي بموجب التزام تجاه نصيب، أو مقدّم الخدمة الذي ينفّذها.",
    'errors.stillAcceptingEntries': "لا تزال هذه المسابقة تقبل المشاركات. وتُغلق من تلقاء نفسها عند أيّهما أقرب — ١٠٠ مشاركة مؤهَّلة، أو أجل الإغلاق — ويجري السحب بعدها دون أن يضغط أحد شيئًا.",
    'errors.integrityCheckOpen': "هناك فحص نزاهة مفتوح على هذه المسابقة. والمشاركات مغلقة، ويجري السحب تلقائيًّا بمجرّد حسم الفحص — ولا يضيع شيء بالانتظار.",
    'errors.winnerConfirmsDelivery': "أصبح تأكيد التسليم من الفائز لا من المضيف. تابع المطالبة من لوحتك — ويؤكّد الفائز الاستلام في النهاية.",
    'errors.suspensionNotLiftedByReapplying': "صلاحية الاستضافة لهذا الحساب موقوفة. وإعادة التقديم لن ترفع الإيقاف — يُرجى التواصل معنا.",
  },
});

// The exact sentence the server sends, mapped to its key. Built from the English
// block above so the two cannot drift: if a key is renamed, this map follows it,
// and if an entry is deleted the lookup simply stops matching rather than
// pointing at a key that no longer exists.
window.NaseebServerErrors = (function buildServerErrorIndex() {
  const index = Object.create(null);
  const en = window.NaseebI18n && window.NaseebI18n.dictionary
    ? window.NaseebI18n.dictionary('en')
    : null;
  if (!en) return index;
  Object.keys(en).forEach((key) => {
    if (key.indexOf('errors.') !== 0) return;
    // Normalised so a trailing space or a curly apostrophe in one copy of the
    // sentence does not stop it matching the other.
    index[en[key].replace(/\s+/g, ' ').trim()] = key;
  });
  return index;
}());
