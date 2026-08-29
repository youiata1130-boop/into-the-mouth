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
  const centralInset = targetWidth * 0.2;
  const centralLeft = target.left + centralInset;
  const centralRight = target.right - centralInset;
  const targetY = target.top + (target.bottom - target.top) * 0.5;
  const observedCrossing = evaluateObservedCrossing(samples, targetY, centralLeft, centralRight);
  if (observedCrossing.observed) {
    return observedCrossing.accepted
      ? { accepted: true, reason: null, projectedX: observedCrossing.x, speed }
      : miss("missed-target", speed, observedCrossing.x);
  }

  const projectionMs = (targetY - end.y) / velocityY;

  if (!Number.isFinite(projectionMs) || projectionMs < 0 || projectionMs > maximumProjectionMs) {
    return miss("missed-target", speed);
  }

  const projectedX = end.x + velocityX * projectionMs;
  const hitsTarget =
    projectedX >= centralLeft &&
    projectedX <= centralRight;

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

function evaluateObservedCrossing(
  samples: readonly FlickPoint[],
  targetY: number,
  centralLeft: number,
  centralRight: number
): { observed: boolean; accepted: boolean; x: number } {
  const centerX = (centralLeft + centralRight) / 2;
  let observed = false;
  let lastCrossingX = Number.NaN;

  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    const deltaY = current.y - previous.y;

    if (deltaY === 0) {
      if (current.y !== targetY) continue;
      observed = true;
      const segmentLeft = Math.min(previous.x, current.x);
      const segmentRight = Math.max(previous.x, current.x);
      if (segmentRight >= centralLeft && segmentLeft <= centralRight) {
        return {
          observed: true,
          accepted: true,
          x: Math.max(segmentLeft, Math.min(centerX, segmentRight))
        };
      }
      lastCrossingX = Math.abs(previous.x - centerX) <= Math.abs(current.x - centerX)
        ? previous.x
        : current.x;
      continue;
    }

    const crossingRatio = (targetY - previous.y) / deltaY;
    if (crossingRatio < 0 || crossingRatio > 1) continue;
    observed = true;
    const crossingX = previous.x + (current.x - previous.x) * crossingRatio;
    if (crossingX >= centralLeft && crossingX <= centralRight) {
      return { observed: true, accepted: true, x: crossingX };
    }
    lastCrossingX = crossingX;
  }

  return { observed, accepted: false, x: lastCrossingX };
}

function miss(reason: FlickMissReason, speed = 0, projectedX = Number.NaN): FlickEvaluation {
  return { accepted: false, reason, projectedX, speed };
}
