export function resolveResizeMode(srcWidth, srcHeight, dstWidth, dstHeight, mode = 'contain') {
  if (mode !== 'smart') return mode;
  const srcRatio = srcWidth / srcHeight;
  const dstRatio = dstWidth / dstHeight;
  const loss = srcRatio > dstRatio
    ? 1 - dstRatio / srcRatio
    : 1 - srcRatio / dstRatio;
  return loss > 0.15 ? 'contain' : 'cover';
}

export function calculateResizeRect({
  srcWidth,
  srcHeight,
  dstWidth,
  dstHeight,
  mode = 'contain',
} = {}) {
  const effectiveMode = resolveResizeMode(srcWidth, srcHeight, dstWidth, dstHeight, mode);
  const srcRatio = srcWidth / srcHeight;
  const dstRatio = dstWidth / dstHeight;

  let sx = 0;
  let sy = 0;
  let sw = srcWidth;
  let sh = srcHeight;
  let dx = 0;
  let dy = 0;
  let dw = dstWidth;
  let dh = dstHeight;

  if (effectiveMode === 'contain') {
    if (srcRatio > dstRatio) {
      dh = dstWidth / srcRatio;
      dy = (dstHeight - dh) / 2;
    } else {
      dw = dstHeight * srcRatio;
      dx = (dstWidth - dw) / 2;
    }
  } else {
    if (srcRatio > dstRatio) {
      sw = srcHeight * dstRatio;
      sx = (srcWidth - sw) / 2;
    } else {
      sh = srcWidth / dstRatio;
      sy = (srcHeight - sh) / 2;
    }
  }

  return { sx, sy, sw, sh, dx, dy, dw, dh, mode: effectiveMode };
}
