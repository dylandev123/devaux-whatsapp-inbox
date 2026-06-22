"use client";

import { useEffect, useState } from "react";
import { getFileName, isVoiceNote, MediaKind } from "@/lib/media";
import { WhatsappMessage } from "@/lib/whatsapp";

interface MediaAttachmentProps {
  message: WhatsappMessage;
  kind: MediaKind;
  /** Whether the surrounding bubble is the solid (outbound) colour, for contrast. */
  outbound: boolean;
}

function ImageLightbox({ url, alt, onClose }: { url: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4"
      onClick={onClose}
    >
      <button
        type="button"
        onClick={onClose}
        className="absolute right-3 top-3 cursor-pointer rounded-full bg-white/10 px-3 py-2 text-sm font-medium text-white hover:bg-white/20"
      >
        Close
      </button>
      {/* eslint-disable-next-line @next/next/no-img-element -- remote, arbitrary-host bridge URLs */}
      <img
        src={url}
        alt={alt}
        onClick={(e) => e.stopPropagation()}
        className="max-h-full max-w-full rounded-lg object-contain"
      />
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="absolute bottom-3 right-3 cursor-pointer rounded-md bg-white/10 px-3 py-2 text-xs font-medium text-white hover:bg-white/20"
      >
        Open original ↗
      </a>
    </div>
  );
}

function BrokenMedia({ url, label, outbound }: { url: string; label: string; outbound: boolean }) {
  return (
    <AttachmentCard
      icon="⚠️"
      title={label}
      subtitle="Couldn't load this attachment"
      url={url}
      actionLabel="Try opening link"
      outbound={outbound}
    />
  );
}

function AttachmentCard({
  icon,
  title,
  subtitle,
  url,
  actionLabel,
  outbound,
}: {
  icon: string;
  title: string;
  subtitle?: string;
  url: string;
  actionLabel: string;
  outbound: boolean;
}) {
  return (
    <div
      className={`flex max-w-full items-center gap-3 rounded-xl border px-3 py-2.5 ${
        outbound ? "border-white/20 bg-white/10" : "border-zinc-200 bg-zinc-50"
      }`}
    >
      <span className="flex-shrink-0 text-2xl leading-none" aria-hidden>
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className={`truncate text-sm font-medium ${outbound ? "text-white" : "text-zinc-900"}`}>
          {title}
        </p>
        {subtitle && (
          <p className={`truncate text-xs ${outbound ? "text-white/70" : "text-zinc-500"}`}>
            {subtitle}
          </p>
        )}
      </div>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className={`flex-shrink-0 rounded-md px-3 py-2 text-xs font-medium ${
          outbound ? "bg-white/20 text-white hover:bg-white/30" : "bg-zinc-200 text-zinc-700 hover:bg-zinc-300"
        }`}
      >
        {actionLabel}
      </a>
    </div>
  );
}

export function MediaAttachment({ message, kind, outbound }: MediaAttachmentProps) {
  const [broken, setBroken] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const url = message.media_url;
  if (!url) return null;

  if (broken) {
    const label =
      kind === "image"
        ? "Image"
        : kind === "video"
        ? "Video"
        : kind === "audio"
        ? isVoiceNote(message) ? "Voice Note" : "Audio message"
        : "Attachment";
    return <BrokenMedia url={url} label={label} outbound={outbound} />;
  }

  if (kind === "image") {
    return (
      <>
        <button
          type="button"
          onClick={() => setLightboxOpen(true)}
          className="block max-w-full cursor-zoom-in"
          aria-label="Open full size image"
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- remote, arbitrary-host bridge URLs */}
          <img
            src={url}
            alt={message.message_body || "Image attachment"}
            onError={() => setBroken(true)}
            className="max-h-72 w-auto max-w-full rounded-lg bg-zinc-100 object-contain"
          />
        </button>
        {lightboxOpen && (
          <ImageLightbox
            url={url}
            alt={message.message_body || "Image attachment"}
            onClose={() => setLightboxOpen(false)}
          />
        )}
      </>
    );
  }

  if (kind === "video") {
    return (
      <div className="flex flex-col gap-1.5">
        <video
          controls
          playsInline
          preload="metadata"
          onError={() => setBroken(true)}
          className="max-h-72 w-full rounded-lg bg-black"
        >
          <source src={url} />
        </video>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className={`self-start text-xs font-medium underline ${
            outbound ? "text-white/80" : "text-zinc-500"
          }`}
        >
          Open video ↗
        </a>
      </div>
    );
  }

  if (kind === "audio") {
    const label = isVoiceNote(message) ? "🎤 Voice Note" : "🎧 Audio message";
    return (
      <div className="flex flex-col gap-1.5">
        <p className={`text-xs font-medium ${outbound ? "text-white/80" : "text-zinc-500"}`}>
          {label}
        </p>
        <audio controls onError={() => setBroken(true)} className="w-full max-w-xs">
          <source src={url} />
        </audio>
      </div>
    );
  }

  if (kind === "document") {
    return (
      <AttachmentCard
        icon="📄"
        title={getFileName(url)}
        subtitle="Document"
        url={url}
        actionLabel="Open document"
        outbound={outbound}
      />
    );
  }

  return (
    <AttachmentCard
      icon="📎"
      title={getFileName(url)}
      subtitle="Attachment"
      url={url}
      actionLabel="Open attachment"
      outbound={outbound}
    />
  );
}
