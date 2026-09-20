<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { PhoneOff, Mic, MicOff, Video, VideoOff } from "lucide-vue-next";
import { api } from "../api";
import { getSocket } from "../socket";
import { useI18n } from "../i18n";
import type { User } from "../types";
import Avatar from "./Avatar.vue";
export interface CallState {
  active: boolean;
  type: "audio" | "video";
  direction: "outgoing" | "incoming";
  remoteUser: User;
  conversationId: string;
  offer?: RTCSessionDescriptionInit;
  pendingCandidates?: RTCIceCandidateInit[];
}
const props = defineProps<{ call: CallState }>();
const emit = defineEmits<{ end: [] }>();
const { t } = useI18n();
const status = ref<"ringing" | "connecting" | "connected" | "ended">(
  props.call.direction === "outgoing" ? "ringing" : "connecting",
);
const muted = ref(false),
  videoOff = ref(props.call.type === "audio"),
  elapsed = ref(0),
  error = ref("");
const localVideo = ref<HTMLVideoElement>(),
  remoteMedia = ref<HTMLVideoElement | HTMLAudioElement>();
let pc: RTCPeerConnection | null = null,
  stream: MediaStream | null = null,
  interval: ReturnType<typeof setInterval> | undefined,
  timeout: ReturnType<typeof setTimeout> | undefined,
  endTimer: ReturnType<typeof setTimeout> | undefined,
  connectedAt = 0,
  pending = [...(props.call.pendingCandidates || [])];
const isVideo = computed(() => props.call.type === "video");
function cleanup() {
  clearInterval(interval);
  clearTimeout(timeout);
  stream?.getTracks().forEach((track) => track.stop());
  pc?.close();
  pc = null;
  stream = null;
}
function finish() {
  status.value = "ended";
  cleanup();
  endTimer = setTimeout(() => emit("end"), 1000);
}
async function start() {
  const socket = getSocket();
  if (!socket) return;
  try {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)
      throw new Error(t("secureMediaRequired"));
    stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: isVideo.value,
    });
    if (localVideo.value) localVideo.value.srcObject = stream;
    pc = new RTCPeerConnection(await api.getIceConfiguration());
    stream.getTracks().forEach((track) => pc?.addTrack(track, stream!));
    pc.ontrack = (event) => {
      if (remoteMedia.value && event.streams[0]) {
        remoteMedia.value.srcObject = event.streams[0];
        remoteMedia.value
          .play()
          .catch(() => (error.value = t("mediaPlaybackBlocked")));
      }
    };
    pc.onicecandidate = (event) => {
      if (event.candidate)
        socket.emit("ice_candidate", {
          targetUserId: props.call.remoteUser.id,
          candidate: event.candidate.toJSON(),
        });
    };
    pc.onconnectionstatechange = () => {
      if (pc?.connectionState === "connected") {
        clearTimeout(timeout);
        status.value = "connected";
        connectedAt = Date.now();
        interval = setInterval(
          () => (elapsed.value = Math.floor((Date.now() - connectedAt) / 1000)),
          1000,
        );
      } else if (
        pc?.connectionState === "failed" ||
        pc?.connectionState === "disconnected"
      ) {
        error.value = t("networkCallFailed");
        finish();
      }
    };
    if (props.call.direction === "outgoing") {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit("call_user", {
        targetUserId: props.call.remoteUser.id,
        conversationId: props.call.conversationId,
        offer: pc.localDescription,
        callType: props.call.type,
      });
    } else if (props.call.offer) {
      await pc.setRemoteDescription(
        new RTCSessionDescription(props.call.offer),
      );
      for (const candidate of pending.splice(0))
        await pc.addIceCandidate(candidate);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit("call_answer", {
        targetUserId: props.call.remoteUser.id,
        answer: pc.localDescription,
      });
    }
    timeout = setTimeout(() => {
      if (pc?.connectionState !== "connected") {
        error.value = t("callTimedOut");
        finish();
      }
    }, 30000);
  } catch (cause) {
    const name = cause instanceof DOMException ? cause.name : "";
    error.value =
      name === "NotAllowedError"
        ? t("mediaPermissionDenied")
        : name === "NotFoundError"
          ? t("mediaDeviceMissing")
          : cause instanceof Error
            ? cause.message
            : t("mediaSetupFailed");
    finish();
  }
}
function answered(data: { from: string; answer: RTCSessionDescriptionInit }) {
  if (data.from !== props.call.remoteUser.id || !pc) return;
  status.value = "connecting";
  pc.setRemoteDescription(new RTCSessionDescription(data.answer))
    .then(async () => {
      for (const candidate of pending.splice(0))
        await pc?.addIceCandidate(candidate);
    })
    .catch(() => (error.value = t("networkCallFailed")));
}
function candidate(data: { from: string; candidate: RTCIceCandidateInit }) {
  if (data.from !== props.call.remoteUser.id) return;
  if (!pc?.remoteDescription) pending.push(data.candidate);
  else
    pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(
      () => (error.value = t("networkCallFailed")),
    );
}
function ended(data: { from: string }) {
  if (data.from === props.call.remoteUser.id) finish();
}
function rejected(data: { from: string }) {
  if (data.from === props.call.remoteUser.id) {
    error.value = t("callRejected");
    finish();
  }
}
onMounted(() => {
  start();
  const socket = getSocket();
  socket?.on("call_answered", answered);
  socket?.on("ice_candidate", candidate);
  socket?.on("call_ended", ended);
  socket?.on("call_rejected", rejected);
});
onBeforeUnmount(() => {
  const socket = getSocket();
  socket?.off("call_answered", answered);
  socket?.off("ice_candidate", candidate);
  socket?.off("call_ended", ended);
  socket?.off("call_rejected", rejected);
  clearTimeout(endTimer);
  cleanup();
});
function toggleMute() {
  const track = stream?.getAudioTracks()[0];
  if (track) {
    track.enabled = !track.enabled;
    muted.value = !track.enabled;
  }
}
function toggleVideo() {
  const track = stream?.getVideoTracks()[0];
  if (track) {
    track.enabled = !track.enabled;
    videoOff.value = !track.enabled;
  }
}
function endCall() {
  getSocket()?.emit("call_end", { targetUserId: props.call.remoteUser.id });
  finish();
}
const timeText = computed(
  () =>
    `${Math.floor(elapsed.value / 60)}:${String(elapsed.value % 60).padStart(2, "0")}`,
);
</script>
<template>
  <div class="call-overlay">
    <div v-if="error" class="call-error" role="alert">{{ error }}</div>
    <template v-if="isVideo"
      ><video
        ref="remoteMedia"
        class="call-remote-video"
        autoplay
        playsinline
      /><video
        ref="localVideo"
        class="call-local-video"
        autoplay
        playsinline
        muted
      />
      <div class="call-video-info">
        <div class="call-user-name">{{ call.remoteUser.displayName }}</div>
        <div class="call-status-text">
          {{
            status === "ringing"
              ? t("ringing")
              : status === "connecting"
                ? t("connecting")
                : status === "connected"
                  ? timeText
                  : t("callEnded")
          }}
        </div>
      </div></template
    >
    <div v-else class="call-audio-view">
      <Avatar
        :name="call.remoteUser.displayName"
        :color="call.remoteUser.avatarColor"
      />
      <div class="call-user-name">{{ call.remoteUser.displayName }}</div>
      <div class="call-status-text">
        {{
          status === "ringing"
            ? t("ringing")
            : status === "connecting"
              ? t("connecting")
              : status === "connected"
                ? timeText
                : t("callEnded")
        }}
      </div>
      <audio ref="remoteMedia" autoplay />
    </div>
    <div class="call-controls">
      <button
        class="call-control-btn"
        :class="{ active: muted }"
        :title="muted ? t('unmute') : t('mute')"
        @click="toggleMute"
      >
        <MicOff v-if="muted" :size="24" /><Mic v-else :size="24" /></button
      ><button
        v-if="isVideo"
        class="call-control-btn"
        :class="{ active: videoOff }"
        :title="videoOff ? t('turnOnCamera') : t('turnOffCamera')"
        @click="toggleVideo"
      >
        <VideoOff v-if="videoOff" :size="24" /><Video
          v-else
          :size="24"
        /></button
      ><button
        class="call-control-btn end"
        :title="t('endCall')"
        @click="endCall"
      >
        <PhoneOff :size="24" />
      </button>
    </div>
  </div>
</template>
