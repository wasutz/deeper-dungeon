"use client";

import { useEffect, useRef, useState } from "react";
import { createFriendReader, spriteFrame, type GenerationSprites, type SpriteFacing } from "@rarefriends/friendsdk/sprites";

const reader = createFriendReader();

/**
 * The selected Friend's canonical pixels, drawn the way the SDK's world view draws them:
 * a 16 x 16 one-bit mask at integer 5x scale, black body over a one-pixel white halo,
 * clipped to the 80 x 80 box. Nothing here rotates, recolours or resamples the artwork.
 */
export function FriendSprite({ friendId, facing = "down", walking = false, reducedMotion = false, className = "" }: {
  friendId: bigint; facing?: SpriteFacing; walking?: boolean; reducedMotion?: boolean; className?: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [sprites, setSprites] = useState<GenerationSprites | null>(null);
  const live = useRef({ facing, walking, reducedMotion });
  live.current = { facing, walking, reducedMotion };

  useEffect(() => {
    let active = true;
    setSprites(null);
    void reader.read(friendId).then(value => { if (active) setSprites(value); }).catch(() => undefined);
    return () => { active = false; };
  }, [friendId]);

  useEffect(() => {
    const node = canvas.current, context = node?.getContext("2d");
    if (!node || !context || !sprites) return;
    let frame = 0;
    const render = (now: number) => {
      const state = live.current;
      const index = state.walking && !state.reducedMotion ? Math.floor(now / 110) % 8 : 0;
      const rows = spriteFrame(sprites, state.facing, state.walking, index).frame.rows;
      context.clearRect(0, 0, 80, 80);
      context.imageSmoothingEnabled = false;
      const pixels = rows.flatMap((row, y) => [...row].flatMap((pixel, x) => pixel === "#" ? [[x, y] as const] : []));
      context.save();
      context.beginPath();
      context.rect(0, 0, 80, 80);
      context.clip();
      context.fillStyle = "#fff";
      for (const [x, y] of pixels) context.fillRect(x * 5 - 5, y * 5 - 5, 15, 15);
      context.fillStyle = "#000";
      for (const [x, y] of pixels) context.fillRect(x * 5, y * 5, 5, 5);
      context.restore();
      frame = requestAnimationFrame(render);
    };
    frame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frame);
  }, [sprites]);

  return <canvas ref={canvas} width={80} height={80} className={`deeper-sprite ${className}`}
    aria-label={sprites ? `Rare Friend #${friendId}` : "Loading Friend artwork"} role="img" />;
}
