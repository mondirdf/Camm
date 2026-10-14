import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import {
  activeCameraMotionId,
  getActiveCameraMotion,
  initCameraVerbs,
  interruptCameraMotion,
  interruptCameraMotionIfActive,
  moveCamera,
} from './cameraVerbs.js';
import { getRenderGovernorDiagnostics } from './renderGovernor.js';

const radians = Cesium.Math.toRadians;
const clone = (value) => Cesium.Cartesian3.clone(value);
const longitude = (camera) =>
  Cesium.Cartographic.fromCartesian(camera.positionWC).longitude;
const wrappedAngle = Cesium.Math.negativePiToPi;
const hasRenderHold = () =>
  getRenderGovernorDiagnostics().holds.includes('camera-verb');

function near(actual, expected, tolerance = 1e-10, message = '') {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message}: expected ${expected}, received ${actual}`,
  );
}

function pose(camera) {
  return {
    position: clone(camera.positionWC),
    direction: clone(camera.directionWC),
    up: clone(camera.upWC),
  };
}

function samePose(camera, expected) {
  const actual = pose(camera);
  for (const key of ['position', 'direction', 'up']) {
    near(
      Cesium.Cartesian3.distance(actual[key], expected[key]),
      0,
      key === 'position' ? 1e-6 : 1e-10,
      key,
    );
  }
}

/** Camera-space screen coordinates, before FOV/aspect scaling. */
function projection(camera, target = Cesium.Cartesian3.ZERO) {
  const offset = Cesium.Cartesian3.subtract(
    target,
    camera.positionWC,
    new Cesium.Cartesian3(),
  );
  const depth = Cesium.Cartesian3.dot(offset, camera.directionWC);
  return {
    x: Cesium.Cartesian3.dot(offset, camera.rightWC) / depth,
    y: Cesium.Cartesian3.dot(offset, camera.upWC) / depth,
    depth,
  };
}

/** Real Cesium geometry with no renderer, GPU, provider or wall-clock waits. */
function harness(
  t,
  {
    latitude = 15,
    longitudeDeg = 0,
    height = 18_000_000,
    heading = 0,
    pitch = -90,
    roll = 0,
  } = {},
) {
  const realPerformance = globalThis.performance;
  let nowMs = 0;
  globalThis.performance = { now: () => nowMs };
  const canvas = Object.assign(new EventTarget(), {
    clientWidth: 1280,
    clientHeight: 800,
    width: 1280,
    height: 800,
  });
  const scene = {
    canvas,
    drawingBufferWidth: 1280,
    drawingBufferHeight: 800,
    mapProjection: new Cesium.GeographicProjection(Cesium.Ellipsoid.WGS84),
    globe: { ellipsoid: Cesium.Ellipsoid.WGS84 },
    mapMode2D: Cesium.MapMode2D.INFINITE_SCROLL,
    mode: Cesium.SceneMode.SCENE3D,
    pixelRatio: 1,
    tweens: [],
    requestRender() {},
  };
  const camera = new Cesium.Camera(scene);
  scene.camera = camera;
  camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(longitudeDeg, latitude, height),
    orientation: {
      heading: radians(heading),
      pitch: radians(pitch),
      roll: radians(roll),
    },
  });
  const viewer = {
    camera,
    scene,
    trackedEntity: undefined,
    clock: { onTick: new Cesium.Event() },
  };
  const target = Cesium.Cartesian3.fromDegrees(longitudeDeg, latitude, 0);
  initCameraVerbs(viewer, () => target);
  t.after(() => {
    interruptCameraMotion('test-cleanup');
    globalThis.performance = realPerformance;
  });
  const tick = (seconds = 0.1) => {
    nowMs += seconds * 1000;
    viewer.clock.onTick.raiseEvent(viewer.clock);
  };
  const finishOnce = () => {
    for (let i = 0; i < 20 && getActiveCameraMotion(); i += 1) tick();
    assert.equal(getActiveCameraMotion(), null, 'once motion must finish');
  };
  return { viewer, camera, canvas, target, tick, finishOnce };
}

for (const latitude of [0, 30, -60, 89.5]) {
  test(`globe rotation preserves Earth framing and radius from latitude ${latitude} degrees`, (t) => {
    const { camera, tick, finishOnce } = harness(t, { latitude });
    const before = projection(camera);
    const radius = Cesium.Cartesian3.magnitude(camera.positionWC);
    const direction = clone(camera.directionWC);
    const started = moveCamera({ motion: 'rotate_globe' });
    assert.equal(started.ok, true);
    assert.equal(started.direction, 'right');
    assert.equal(started.mode, 'once');
    for (let i = 0; i < 5; i += 1) {
      tick();
      const current = projection(camera);
      near(current.x, before.x);
      near(current.y, before.y);
      near(current.depth, before.depth, 1e-6);
      near(Cesium.Cartesian3.magnitude(camera.positionWC), radius, 1e-6);
    }
    finishOnce();
    near(
      Cesium.Cartesian3.angleBetween(camera.directionWC, direction),
      radians(15),
    );
    assert.equal(hasRenderHold(), false);
  });
}

for (const [direction, sign] of [
  ['left', -1],
  ['right', 1],
]) {
  test(`globe ${direction} means visible landmark motion ${direction}`, (t) => {
    const { camera, target, finishOnce } = harness(t, { latitude: 0 });
    const originalLongitude = longitude(camera);
    near(projection(camera, target).x, 0);
    assert.equal(moveCamera({ motion: 'rotate_globe', direction }).ok, true);
    finishOnce();
    assert.ok(sign * projection(camera, target).x > 0.05);
    near(
      wrappedAngle(longitude(camera) - originalLongitude),
      -sign * radians(15),
    );
  });
}

for (const view of [
  { label: 'north-up', heading: 0 },
  { label: 'east-up', heading: 90 },
  { label: 'south-up', heading: 180 },
  { label: 'tilted east-up', heading: 90, pitch: -82 },
  { label: 'tilted and rolled', heading: 180, pitch: -84, roll: 35 },
  { label: 'near the pole', latitude: 89.5, heading: 180, roll: -25 },
]) {
  for (const [direction, sign] of [
    ['left', -1],
    ['right', 1],
  ]) {
    test(`globe ${direction} stays screen-horizontal in a ${view.label} view`, (t) => {
      const { camera, tick, finishOnce } = harness(t, view);
      const ray = new Cesium.Ray(
        clone(camera.positionWC),
        clone(camera.directionWC),
      );
      const intersection = Cesium.IntersectionTests.rayEllipsoid(
        ray,
        Cesium.Ellipsoid.WGS84,
      );
      assert.ok(intersection, 'the original screen center must see the globe');
      const landmark = Cesium.Ray.getPoint(
        ray,
        intersection.start,
        new Cesium.Cartesian3(),
      );
      const before = projection(camera);
      const radius = Cesium.Cartesian3.magnitude(camera.positionWC);
      const originalLandmark = projection(camera, landmark);
      near(originalLandmark.x, 0);
      near(originalLandmark.y, 0);
      // Exercise both bounded and continuous application of the same direction.
      const mode = direction === 'left' ? 'once' : 'continuous';
      assert.equal(
        moveCamera({ motion: 'rotate_globe', direction, mode }).ok,
        true,
      );
      if (mode === 'once') finishOnce();
      else {
        tick();
        tick(0.25);
      }
      const after = projection(camera);
      const movedLandmark = projection(camera, landmark);
      assert.ok(
        sign * movedLandmark.x > 0.001,
        'landmark must move in the requested screen direction',
      );
      near(movedLandmark.y, originalLandmark.y);
      near(after.x, before.x);
      near(after.y, before.y);
      near(after.depth, before.depth, 1e-6);
      near(Cesium.Cartesian3.magnitude(camera.positionWC), radius, 1e-6);
    });
  }
}

test('equal left and right globe rotations restore the complete camera pose', (t) => {
  const { camera, finishOnce } = harness(t, {
    latitude: 42,
    longitudeDeg: 170,
  });
  const before = pose(camera);
  moveCamera({ motion: 'rotate_globe', direction: 'right' });
  finishOnce();
  moveCamera({ motion: 'rotate_globe', direction: 'left' });
  finishOnce();
  samePose(camera, before);
});

test('globe rotation converts an inherited target frame without zooming or recentering', (t) => {
  const { camera, target, tick } = harness(t);
  camera.lookAt(
    target,
    new Cesium.HeadingPitchRange(radians(35), radians(-35), 5_000),
  );
  assert.equal(
    Cesium.Matrix4.equals(camera.transform, Cesium.Matrix4.IDENTITY),
    false,
  );
  const before = pose(camera);
  const screen = projection(camera);
  const range = Cesium.Cartesian3.magnitude(camera.positionWC);
  moveCamera({
    motion: 'rotate_globe',
    direction: 'right',
    mode: 'continuous',
  });
  assert.equal(
    Cesium.Matrix4.equals(camera.transform, Cesium.Matrix4.IDENTITY),
    true,
  );
  samePose(camera, before);
  tick();
  tick();
  near(Cesium.Cartesian3.magnitude(camera.positionWC), range, 1e-6);
  near(projection(camera).x, screen.x);
  near(projection(camera).y, screen.y);
});

for (const [speed, degreesPerSecond] of [
  ['slow', 4],
  ['normal', 10],
  ['fast', 20],
]) {
  test(`continuous globe rotation honors ${speed} speed and explicit stop`, (t) => {
    const { camera, tick } = harness(t);
    const result = moveCamera({
      motion: 'rotate_globe',
      mode: 'continuous',
      speed,
    });
    assert.equal(result.ok, true);
    assert.equal(hasRenderHold(), true);
    tick(); // First tick initializes the motion's wall-clock anchor.
    const before = clone(camera.directionWC);
    tick(0.1);
    near(
      Cesium.Cartesian3.angleBetween(camera.directionWC, before),
      radians(degreesPerSecond * 0.1),
    );
    assert.equal(getActiveCameraMotion()?.kind, 'rotate_globe');
    const stopped = moveCamera({ motion: 'stop' });
    assert.equal(stopped.stopped, true);
    assert.equal(hasRenderHold(), false);
    const after = pose(camera);
    tick();
    samePose(camera, after);
    assert.equal(moveCamera({ motion: 'stop' }).stopped, false);
  });
}

for (const event of ['pointerdown', 'wheel']) {
  test(`${event} immediately cancels globe rotation and releases the render hold`, (t) => {
    const { camera, canvas, tick } = harness(t);
    moveCamera({ motion: 'rotate_globe', mode: 'continuous' });
    tick();
    tick();
    const before = pose(camera);
    canvas.dispatchEvent(new Event(event));
    assert.equal(getActiveCameraMotion(), null);
    assert.equal(hasRenderHold(), false);
    tick();
    samePose(camera, before);
  });
}

test('new navigation can cancel globe rotation before setting a new destination', (t) => {
  const { camera, tick } = harness(t);
  moveCamera({ motion: 'rotate_globe', mode: 'continuous' });
  tick();
  assert.equal(interruptCameraMotion('explicit-navigation').wasActive, true);
  camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(110, -25, 1_000_000),
  });
  const destination = pose(camera);
  tick();
  samePose(camera, destination);
  assert.equal(hasRenderHold(), false);
});

test('replacement motion rejects a stale globe owner cancellation', (t) => {
  const { camera, tick } = harness(t);
  moveCamera({ motion: 'rotate_globe', mode: 'continuous' });
  const globeId = activeCameraMotionId();
  moveCamera({ motion: 'rotate', direction: 'left', mode: 'continuous' });
  const yawId = activeCameraMotionId();
  assert.notEqual(yawId, globeId);
  assert.equal(interruptCameraMotionIfActive(globeId).wasActive, false);
  assert.equal(getActiveCameraMotion()?.kind, 'rotate');
  const position = clone(camera.positionWC);
  tick();
  tick();
  near(Cesium.Cartesian3.distance(camera.positionWC, position), 0, 1e-6);
  assert.equal(interruptCameraMotionIfActive(yawId).wasActive, true);
  assert.equal(hasRenderHold(), false);
});

for (const direction of ['up', 'down', 'diagonal']) {
  test(`invalid globe direction ${direction} is refused before camera authority handoff`, (t) => {
    const { camera } = harness(t);
    const before = pose(camera);
    let handoffs = 0;
    const result = moveCamera({ motion: 'rotate_globe', direction }, () => {
      handoffs += 1;
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /left or right/);
    assert.equal(handoffs, 0);
    assert.equal(getActiveCameraMotion(), null);
    assert.equal(hasRenderHold(), false);
    samePose(camera, before);
  });
}

test('direct globe rotation refuses a tracked camera without disturbing its reference frame', (t) => {
  const { viewer, camera, target } = harness(t);
  viewer.trackedEntity = { id: 'tracked-aircraft' };
  camera.lookAt(target, new Cesium.HeadingPitchRange(0, radians(-40), 1_000));
  const before = pose(camera);
  const transform = Cesium.Matrix4.clone(camera.transform);
  const result = moveCamera({ motion: 'rotate_globe' });
  assert.equal(result.ok, false);
  assert.match(result.error, /following tracked-aircraft/);
  assert.equal(Cesium.Matrix4.equals(camera.transform, transform), true);
  samePose(camera, before);
  assert.equal(getActiveCameraMotion(), null);
  assert.equal(hasRenderHold(), false);
});

test('near-pole close view refuses globe rotation before handing off camera authority', (t) => {
  const { camera, tick } = harness(t, { latitude: 89.5, height: 1_000 });
  const before = pose(camera);
  let handoffs = 0;
  const result = moveCamera({ motion: 'rotate_globe' }, () => {
    handoffs += 1;
  });
  assert.equal(result.ok, false);
  assert.equal(
    result.error,
    'Zoom out before rotating the globe, or use orbit for this local view.',
  );
  assert.equal(handoffs, 0);
  assert.equal(getActiveCameraMotion(), null);
  assert.equal(hasRenderHold(), false);
  tick();
  samePose(camera, before);
});

test('equatorial close view outside the ellipsoid bounding sphere can rotate without changing range', (t) => {
  const { camera, tick } = harness(t, {
    latitude: 0,
    height: 1_000,
    heading: 90,
  });
  const radius = Cesium.Cartesian3.magnitude(camera.positionWC);
  assert.equal(
    moveCamera({ motion: 'rotate_globe', mode: 'continuous' }).ok,
    true,
  );
  for (let i = 0; i < 40; i += 1) {
    tick();
    near(Cesium.Cartesian3.magnitude(camera.positionWC), radius, 1e-6);
    assert.ok(Cesium.Cartographic.fromCartesian(camera.positionWC).height > 0);
  }
});

test('globe clearance uses the active ellipsoid maximum radius and refuses its exact boundary', (t) => {
  const { viewer, camera } = harness(t);
  const radius = Cesium.Cartesian3.magnitude(camera.positionWC);
  viewer.scene.globe.ellipsoid = new Cesium.Ellipsoid(radius, radius, radius);
  const before = pose(camera);
  let handoffs = 0;
  const result = moveCamera({ motion: 'rotate_globe' }, () => {
    handoffs += 1;
  });
  assert.equal(result.ok, false);
  assert.equal(handoffs, 0);
  samePose(camera, before);
});

test('globe clearance falls back to WGS84 when the scene has no ellipsoid', (t) => {
  const { viewer, camera } = harness(t, { latitude: 89.5, height: 1_000 });
  delete viewer.scene.globe.ellipsoid;
  const before = pose(camera);
  assert.equal(moveCamera({ motion: 'rotate_globe' }).ok, false);
  samePose(camera, before);
});

test('authorized navigation handoff releases tracking before globe rotation starts', (t) => {
  const { viewer, camera, tick } = harness(t);
  viewer.trackedEntity = { id: 'tracked-aircraft' };
  let handedOff = false;
  const result = moveCamera({ motion: 'rotate_globe' }, (start, options) => {
    assert.equal(options.preserveCameraFlight, false);
    viewer.trackedEntity = undefined;
    camera.cancelFlight();
    camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    handedOff = true;
    return start();
  });
  assert.equal(handedOff, true);
  assert.equal(result.ok, true);
  const before = longitude(camera);
  tick();
  assert.ok(longitude(camera) < before);
});

test('legacy rotate remains local yaw at an unchanged camera position', (t) => {
  const { camera, finishOnce } = harness(t, { latitude: 0 });
  const before = pose(camera);
  moveCamera({ motion: 'rotate', direction: 'right' });
  finishOnce();
  near(Cesium.Cartesian3.distance(camera.positionWC, before.position), 0, 1e-6);
  near(
    Cesium.Cartesian3.angleBetween(camera.directionWC, before.direction),
    radians(15),
  );
  assert.ok(
    Math.abs(projection(camera).x) > 0.2,
    'local yaw intentionally moves Earth out of the center',
  );
});

test('legacy orbit still revolves around the selected ground target', (t) => {
  const { camera, target, tick } = harness(t);
  camera.lookAt(target, new Cesium.HeadingPitchRange(0, radians(-45), 4_000));
  camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  const range = Cesium.Cartesian3.distance(camera.positionWC, target);
  moveCamera({ motion: 'orbit', direction: 'right', mode: 'continuous' });
  tick();
  tick();
  assert.equal(getActiveCameraMotion()?.kind, 'orbit');
  near(Cesium.Cartesian3.distance(camera.positionWC, target), range, 1e-6);
  near(projection(camera, target).x, 0);
  near(projection(camera, target).y, 0);
  interruptCameraMotion('test-stop');
  assert.equal(
    Cesium.Matrix4.equals(camera.transform, Cesium.Matrix4.IDENTITY),
    true,
  );
});
