import { computed, onScopeDispose, ref, shallowRef, watch, type Ref } from "vue";
import { onHide, onShow, onUnload } from "@dcloudio/uni-app";
import { feedbackValidationError, getFeedbackMessage, submitFeedback } from "@/api/feedback";
import { useAuthStore } from "@/stores/auth";
import { RequestError, toLogin } from "@/utils/request";

type Auth = ReturnType<typeof useAuthStore>;
type SubmissionState = "idle" | "pending" | "unknown";
interface SessionSubmission {
  uid: number;
  version: number;
  state: Ref<SubmissionState>;
}

// In-memory only: no draft, contact information, token, or request body is retained here.
// Re-entering this page in the same login cannot silently resend an uncertain request.
// A full app restart clears this guard; the API has no server-side idempotency contract.
const sessionSubmissions = new WeakMap<Auth, SessionSubmission>();
const unknownMessage = "提交结果尚未确认，请先联系客服核实。当前登录期间已暂停再次提交，避免重复反馈。";

function currentSubmission(auth: Auth): SessionSubmission {
  const previous = sessionSubmissions.get(auth);
  if (previous && previous.uid === auth.uid && previous.version === auth.sessionVersion) return previous;
  const next: SessionSubmission = { uid: auth.uid, version: auth.sessionVersion, state: ref("idle") };
  sessionSubmissions.set(auth, next);
  return next;
}

function definitiveRejection(cause: unknown): cause is RequestError {
  // The feedback handler validates before its single INSERT. A 500 or a lost/invalid
  // response can follow that INSERT and cannot prove that nothing was saved.
  return cause instanceof RequestError && cause.status === 400
    && (cause.httpStatus === 400 || (cause.httpStatus !== undefined && cause.httpStatus >= 200 && cause.httpStatus < 300));
}

export function useFeedback() {
  const auth = useAuthStore();
  const name = ref("");
  const phone = ref("");
  const content = ref("");
  const message = ref("");
  const error = ref("");
  const visible = ref(false);
  const disposed = ref(false);
  const session = shallowRef<SessionSubmission>(currentSubmission(auth));
  const loggedIn = computed(() => auth.isLoggedIn && Number.isSafeInteger(auth.uid) && auth.uid > 0);
  const submitting = computed(() => session.value.state.value === "pending");
  const unknown = computed(() => session.value.state.value === "unknown");
  const canEdit = computed(() => visible.value && !disposed.value && loggedIn.value && !submitting.value && !unknown.value);
  let generation = 0;
  let readGeneration = 0;
  let draftVersion = 0;
  watch([name, phone, content], () => { draftVersion++; }, { flush: "sync" });

  function clearDraft(): void {
    name.value = "";
    phone.value = "";
    content.value = "";
  }

  function capture() {
    const owner = { uid: auth.uid, token: auth.token, version: auth.sessionVersion, generation };
    return () => visible.value && !disposed.value && loggedIn.value && generation === owner.generation
      && auth.uid === owner.uid && auth.token === owner.token && auth.sessionVersion === owner.version;
  }

  async function loadMessage(): Promise<void> {
    if (!visible.value || disposed.value || !loggedIn.value) return;
    const current = capture(), reading = ++readGeneration;
    try {
      const result = await getFeedbackMessage();
      if (current() && reading === readGeneration) message.value = typeof result?.feedback === "string" ? result.feedback : "";
    } catch {
      // An optional introduction failure must not prevent submission or erase its state.
    }
  }

  async function submit(): Promise<void> {
    // A stopped Vue scope can retain a cached computed value; never rely on it
    // alone when an already-detached native handler calls this method.
    if (!visible.value || disposed.value || !canEdit.value) return;
    const input = { rela_name: name.value.trim(), phone: phone.value.trim(), content: content.value.trim() };
    error.value = feedbackValidationError(input);
    if (error.value) return;
    const current = capture(), submittedDraftVersion = draftVersion, submission = session.value;
    submission.state.value = "pending";
    try {
      const result = await submitFeedback(input);
      if (!current()) return;
      if (!result || !Number.isSafeInteger(result.id) || result.id <= 0) {
        throw new RequestError("反馈提交回执无效");
      }
      submission.state.value = "idle";
      // Native controls are disabled while pending; also preserve a draft changed by
      // another local caller rather than clearing text that this request never sent.
      if (draftVersion === submittedDraftVersion) clearDraft();
      error.value = "";
      uni.showToast({ title: "反馈已提交", icon: "success" });
    } catch (cause) {
      if (!current()) return;
      if (definitiveRejection(cause)) {
        submission.state.value = "idle";
        error.value = cause.message;
      } else {
        submission.state.value = "unknown";
        error.value = unknownMessage;
      }
    }
  }

  function suspend(): void {
    visible.value = false;
    generation++;
    readGeneration++;
    if (session.value.state.value === "pending") session.value.state.value = "unknown";
    message.value = "";
    error.value = "";
  }

  function dispose(): void { disposed.value = true; suspend(); clearDraft(); }
  watch(() => [auth.uid, auth.token, auth.sessionVersion], () => {
    generation++;
    readGeneration++;
    clearDraft();
    message.value = "";
    error.value = "";
    // All live pages must use the same record for a login epoch. A token-only
    // refresh cannot prove the result of an old in-flight write, so retain UNKNOWN.
    if (session.value.uid === auth.uid && session.value.version === auth.sessionVersion
      && session.value.state.value === "pending") session.value.state.value = "unknown";
    session.value = currentSubmission(auth);
  }, { flush: "sync" });
  onShow(() => {
    if (disposed.value) return;
    generation++;
    visible.value = true;
    session.value = currentSubmission(auth);
    if (session.value.state.value === "pending") session.value.state.value = "unknown";
    error.value = unknown.value ? unknownMessage : "";
    void loadMessage();
  });
  onHide(suspend);
  onUnload(dispose);
  onScopeDispose(dispose);

  function login(): void {
    if (!visible.value || disposed.value) return;
    suspend();
    toLogin();
  }

  return { name, phone, content, message, error, loggedIn, submitting, unknown, canEdit, submit, login };
}
