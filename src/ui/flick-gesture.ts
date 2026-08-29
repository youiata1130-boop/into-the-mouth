export type FlickPoint = {
  x: number;
  y: number;
  time: number;
};

export type FlickTarget = {
  left: number;
  right: number;
  top: number;
  bottom: number;
};

export type FlickMissReason = "too-short" | "too-slow" | "wrong-direction" | "missed-target";

export type FlickEvaluation = {
  accepted: boolean;
  reason: FlickMissReason | null;
  projectedX: number;
  speed: number;
};

const minimumTravel = 42;
const minimumUpwardSpeed = 0.28;
const minimumUpwardShare = 0.52;
const velocityWindowMs = 120;
const maximumProjectionMs = 900;

export function evaluateFlickGesture(
  samples: readonly FlickPoint[],
  target: FlickTarget
): FlickEvaluation {
  if (samples.length < 2) return miss("too-short");

  const start = samples[0];
  const end = samples.at(-1)!;
  const totalUpwardTravel = start.y - end.y;

  if (totalUpwardTravel < minimumTravel) return miss("too-short");

  const velocityStart = findVelocityStart(samples, end.time - velocityWindowMs);
  const elapsed = Math.max(1, end.time - velocityStart.time);
  const velocityX = (end.x - velocityStart.x) / elapsed;
  const velocityY = (end.y - velocityStart.y) / elapsed;
  const speed = Math.hypot(velocityX, velocityY);
  const upwardSpeed = -velocityY;

  if (upwardSpeed < minimumUpwardSpeed) return miss("too-slow", speed);
  if (speed === 0 || upwardSpeed / speed < minimumUpwardShare) return miss("wrong-direction", speed);

  const targetWidth = Math.max(1, target.right - target.left);
  const horizontalMargin = Math.max(18, targetWidth * 0.16);
  const isAlreadyInside =
    end.x >= target.left - horizontalMargin &&
    end.x <= target.right + horizontalMargin &&
    end.y >= target.top - 18 &&
    end.y <= target.bottom + 18;

  if (isAlreadyInside) {
    return { accepted: true, reason: null, projectedX: end.x, speed };
  }

  const targetY = target.top + (target.bottom - target.top) * 0.58;
  const totalDeltaY = end.y - start.y;
  const crossingRatio = totalDeltaY === 0 ? -1 : (targetY - start.y) / totalDeltaY;
  if (crossingRatio >= 0 && crossingRatio <= 1) {
    const crossingX = start.x + (end.x - start.x) * crossingRatio;
    const crossedTarget =
      crossingX >= target.left - horizontalMargin &&
      crossingX <= target.right + horizontalMargin;
    return crossedTarget
      ? { accepted: true, reason: null, projectedX: crossingX, speed }
      : miss("missed-target", speed, crossingX);
  }

  const projectionMs = (targetY - end.y) / velocityY;

  if (!Number.isFinite(projectionMs) || projectionMs < 0 || projectionMs > maximumProjectionMs) {
    return miss("missed-target", speed);
  }

  const projectedX = end.x + velocityX * projectionMs;
  const hitsTarget =
    projectedX >= target.left - horizontalMargin &&
    projectedX <= target.right + horizontalMargin;

  return hitsTarget
    ? { accepted: true, reason: null, projectedX, speed }
    : miss("missed-target", speed, projectedX);
}

function findVelocityStart(samples: readonly FlickPoint[], minimumTime: number): FlickPoint {
  for (let index = 0; index < samples.length - 1; index += 1) {
    if (samples[index].time >= minimumTime) return samples[index];
  }
  return samples.at(-2) ?? samples[0];
}

function miss(reason: FlickMissReason, speed = 0, projectedX = Number.NaN): FlickEvaluation {
  return { accepted: false, reason, projectedX, speed };
}
