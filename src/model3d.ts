// A simple 3D viewer for STL models: rotate, zoom, pan, fit.
// three.js is loaded only when a model is opened, so PDF users never pay for it.

import type * as THREE_NS from "three";

export interface ModelInfo {
  triangles: number;
  /** Bounding-box size in file units (usually millimetres), X × Y × Z as stored in the file. */
  size: [number, number, number];
}

export interface LoadedModel {
  geometry: THREE_NS.BufferGeometry;
  info: ModelInfo;
}

export interface ViewState {
  position: [number, number, number];
  target: [number, number, number];
}

type Three = typeof THREE_NS;
let threePromise: Promise<{ THREE: Three; STLLoader: any; OrbitControls: any }> | null = null;
function loadThree() {
  threePromise ??= Promise.all([
    import("three"),
    import("three/examples/jsm/loaders/STLLoader.js"),
    import("three/examples/jsm/controls/OrbitControls.js"),
  ]).then(([THREE, stl, orbit]) => ({ THREE, STLLoader: stl.STLLoader, OrbitControls: orbit.OrbitControls }));
  return threePromise;
}

export async function parseStl(bytes: Uint8Array): Promise<LoadedModel> {
  const { STLLoader } = await loadThree();
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  let geometry: THREE_NS.BufferGeometry;
  try {
    geometry = new STLLoader().parse(buf);
  } catch {
    throw new Error("This doesn't look like a valid STL file.");
  }
  const pos = geometry.getAttribute("position");
  if (!pos || pos.count === 0) throw new Error("This STL file contains no triangles.");
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox!;
  const size: [number, number, number] = [bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z];
  // Center on the origin; the viewer treats Z as up, as most CAD and slicer tools do.
  const cx = (bb.min.x + bb.max.x) / 2, cy = (bb.min.y + bb.max.y) / 2, cz = (bb.min.z + bb.max.z) / 2;
  geometry.translate(-cx, -cy, -cz);
  // Many STL files store zero normals, so always compute them (gives flat shading per facet).
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return { geometry, info: { triangles: Math.round(pos.count / 3), size } };
}

export interface ModelViewer {
  show(model: LoadedModel, view?: ViewState | null): void;
  resetView(): void;
  zoom(factor: number): void;
  getView(): ViewState | null;
  dispose(): void;
}

export async function createModelViewer(host: HTMLElement): Promise<ModelViewer> {
  const { THREE, OrbitControls } = await loadThree();
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  host.append(renderer.domElement);
  renderer.domElement.classList.add("model-canvas");

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1e7);
  camera.up.set(0, 0, 1);
  scene.add(camera);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f99, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(1, 1.5, 2);
  camera.add(key); // a "headlight" keeps the model lit from any angle

  const material = new THREE.MeshStandardMaterial({ color: 0x8fb3ae, roughness: 0.55, metalness: 0.08 });
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
  scene.add(mesh);
  let grid: THREE_NS.GridHelper | null = null;

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.screenSpacePanning = true;

  let current: LoadedModel | null = null;
  let frame = 0;
  const render = () => {
    frame = 0;
    if (controls.update()) requestRender();
    renderer.render(scene, camera);
  };
  const requestRender = () => {
    if (!frame) frame = requestAnimationFrame(render);
  };
  controls.addEventListener("change", requestRender);

  const resize = () => {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    requestRender();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(host);

  const fit = () => {
    if (!current) return;
    const r = current.geometry.boundingSphere?.radius || 1;
    const dist = (r / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2))) * 1.15;
    const dir = new THREE.Vector3(1, -1.25, 0.9).normalize();
    camera.position.copy(dir.multiplyScalar(dist));
    camera.near = dist / 1000;
    camera.far = dist * 100;
    camera.updateProjectionMatrix();
    controls.target.set(0, 0, 0);
    controls.update();
    requestRender();
  };

  return {
    show(model, view) {
      current = model;
      mesh.geometry = model.geometry;
      if (grid) {
        scene.remove(grid);
        grid.geometry.dispose();
        (grid.material as THREE_NS.Material).dispose();
      }
      // A floor grid under the model, sized to it, for a sense of scale.
      const [sx, sy, sz] = model.info.size;
      const span = Math.max(sx, sy) * 1.6 || 1;
      const step = Math.pow(10, Math.floor(Math.log10(span / 2)));
      const divisions = Math.max(2, Math.min(100, Math.round(span / step)));
      grid = new THREE.GridHelper(divisions * step, divisions, 0x9aa0a6, 0xc9ccd1);
      grid.rotation.x = Math.PI / 2; // GridHelper lies in XZ; make it XY (Z is up)
      grid.position.z = -sz / 2;
      const gm = grid.material as THREE_NS.LineBasicMaterial;
      gm.transparent = true;
      gm.opacity = 0.5;
      scene.add(grid);
      resize();
      if (view) {
        camera.position.set(...view.position);
        controls.target.set(...view.target);
        const dist = camera.position.distanceTo(controls.target);
        camera.near = dist / 1000;
        camera.far = dist * 100;
        camera.updateProjectionMatrix();
        controls.update();
        requestRender();
      } else fit();
    },
    resetView: fit,
    zoom(factor) {
      const offset = camera.position.clone().sub(controls.target).multiplyScalar(1 / factor);
      camera.position.copy(controls.target).add(offset);
      controls.update();
      requestRender();
    },
    getView() {
      if (!current) return null;
      return { position: camera.position.toArray() as [number, number, number], target: controls.target.toArray() as [number, number, number] };
    },
    dispose() {
      ro.disconnect();
      cancelAnimationFrame(frame);
      controls.dispose();
      material.dispose();
      grid?.geometry.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
