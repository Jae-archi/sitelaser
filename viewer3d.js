import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { STLExporter } from "three/addons/exporters/STLExporter.js";

function openRing(ring) {
  const points = ring.map(point => [point[0], point[1]]);
  if (points.length > 1) {
    const first = points[0];
    const last = points[points.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) points.pop();
  }
  if (points.length < 3) throw new Error("지형판 폐곡선의 점이 부족합니다.");
  return points;
}

function area(ring) {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return Math.abs(sum / 2);
}

function contains(ring, point) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > point[1]) !== (b[1] > point[1]) &&
        point[0] < (b[0] - a[0]) * (point[1] - a[1]) /
          (b[1] - a[1]) + a[0]) {
      inside = !inside;
    }
  }
  return inside;
}

function pathFromRing(ring, origin, shape = false) {
  const path = shape ? new THREE.Shape() : new THREE.Path();
  ring.forEach(([x, y], index) => {
    const a = x - origin[0], b = y - origin[1];
    if (index === 0) path.moveTo(a, b);
    else path.lineTo(a, b);
  });
  path.closePath();
  return path;
}

// Cut rings use even-odd nesting, independent of winding.
// Intersecting or self-crossing contours must be rejected by the Python engine.
function cutShapes(rings, origin) {
  const nodes = rings.map(ring => {
    const points = openRing(ring);
    return { points, area: area(points), parent: -1, depth: 0, shape: null };
  }).sort((a, b) => b.area - a.area);

  nodes.forEach((node, i) => {
    for (let j = i - 1; j >= 0; j--) {
      if (contains(nodes[j].points, node.points[0])) {
        node.parent = j;
        node.depth = nodes[j].depth + 1;
        break;
      }
    }
    if (node.depth % 2 === 0) {
      node.shape = pathFromRing(node.points, origin, true);
    } else {
      nodes[node.parent].shape.holes.push(pathFromRing(node.points, origin));
    }
  });
  return nodes.filter(node => node.shape).map(node => node.shape);
}

function buildingShape(building, origin) {
  const shape = pathFromRing(openRing(building.polygon), origin, true);
  for (const ring of building.holes) {
    shape.holes.push(pathFromRing(openRing(ring), origin));
  }
  return shape;
}

function disposeGroup(group) {
  group.traverse(object => {
    object.geometry?.dispose();
    const materials = Array.isArray(object.material)
      ? object.material : [object.material];
    for (const material of materials) material?.dispose();
  });
  group.clear();
}

export class Viewer3D {
  constructor(element) {
    this.element = element;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color("#e9ece8");

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000000);
    this.camera.up.set(0, 0, 1);
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    element.append(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.addEventListener("change", () => this.render());

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x77766b, 2.3));
    const light = new THREE.DirectionalLight(0xffffff, 2.5);
    light.position.set(-1, -2, 4);
    this.scene.add(light);

    this.model = new THREE.Group();
    this.scene.add(this.model);
    this.plates = [];
    this.buildings = [];
    this.options = { plates: true, buildings: true, edges: true, count: 0 };

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(element);
    this.resize();
  }

  resize() {
    const width = Math.max(1, this.element.clientWidth);
    const height = Math.max(1, this.element.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  render() { this.renderer.render(this.scene, this.camera); }

  clear() {
    disposeGroup(this.model);
    this.plates = [];
    this.buildings = [];
    this.project = null;
    this.render();
  }

  addMesh(shape, depth, z, color, name) {
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth,
      bevelEnabled: false,
      steps: 1,
      curveSegments: 1
    });
    geometry.computeVertexNormals();

    const material = new THREE.MeshStandardMaterial({
      color, roughness: 0.85, metalness: 0
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.position.z = z;

    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry),
      new THREE.LineBasicMaterial({ color: 0x5c5b53, transparent: true, opacity: 0.5 })
    );
    edges.userData.isEdge = true;
    mesh.add(edges);
    this.model.add(mesh);
    return mesh;
  }

  setProject(project, supports = []) {
    this.clear();
    this.project = project;
    const [xmin, ymin, xmax, ymax] = project.bounds;
    this.origin = [(xmin + xmax) / 2, (ymin + ymax) / 2];
    this.layers = [...project.layers].sort((a, b) => a.z - b.z);
    this.thickness = project.settings.thickness_mm * project.settings.scale / 1000;

    try {
      this.layers.forEach((layer, ordinal) => {
        for (const shape of cutShapes(layer.cut, this.origin)) {
          const mesh = this.addMesh(
            shape,
            this.thickness,
            ordinal * this.thickness,
            ordinal % 2 ? 0xc9bd9c : 0xd8ccad,
            `plate_${layer.index}`
          );
          mesh.userData.ordinal = ordinal;
          this.plates.push(mesh);
        }
      });

      // Support pieces under raised buildings: same board as the plate of their
      // level, so the model has no floating buildings. They count as plates
      // (layer slider, 3DM export).
      for (const item of supports) {
        const ordinal = this.layers.findIndex(layer => layer.index === item.layer);
        if (ordinal < 0) continue;
        for (const shape of cutShapes(item.rings, this.origin)) {
          const mesh = this.addMesh(shape, this.thickness, ordinal * this.thickness,
            0xb8ad8f, `support_${item.text}`);
          mesh.userData.ordinal = ordinal;
          this.plates.push(mesh);
        }
      }

      // Show buildings split the way they will be made: per storey for the
      // *_floor modes, per board for "laser", whole for "print".
      const s = project.settings || {};
      const mode = s.building_mode || "print";
      const floorH = s.floor_height_m || 3;
      const boardM = (s.building_thickness_mm || 1) * (s.scale || 1000) / 1000;
      project.buildings.forEach((building, index) => {
        const base = this.stackBase(building.base);
        let n = 1;
        // print_floor: real storeys (IGN count) when known, else h / 층고.
        // laser_floor: equal boards of 층고, so a tall single storey is stacked.
        if (mode === "print_floor") n = building.floors || Math.max(1, Math.round(building.h / floorH));
        else if (mode === "laser_floor") n = Math.max(1, Math.round(building.h / floorH));
        else if (mode === "laser") n = Math.max(1, Math.ceil(building.h / boardM - 1e-6));
        // laser modes: every board has the real board thickness (as cut);
        // print modes: storeys share the exact height
        const laserMode = mode === "laser" || mode === "laser_floor";
        const step = mode === "laser" ? boardM
          : mode === "laser_floor" ? floorH * 1 : building.h / n;
        for (let k = 0; k < n; k++) {
          const depth = laserMode ? step : Math.min(step, building.h - k * step);
          if (depth <= 0) break;
          const mesh = this.addMesh(
            buildingShape(building, this.origin),
            depth,
            base + k * step,
            k % 2 ? 0xdcd8cc : 0xe9e6dc,   // alternate shades show each piece
            n > 1 ? `building_${index + 1}_${k + 1}` : `building_${index + 1}`
          );
          this.buildings.push(mesh);
        }
      });
      this.options.count = this.layers.length;
      this.setOptions(this.options);
      this.fit();
    } catch (error) {
      this.clear();
      throw error;
    }
  }

  stackBase(sourceBase) {
    // A building rests on the top of the last source-height plate below it.
    // Its height remains in source metres, without vertical exaggeration.
    // at least on top of the bottom plate, even if IGN's ground level is
    // slightly below the lowest DEM sample
    let ordinal = 0;
    for (let i = 0; i < this.layers.length; i++) {
      if (this.layers[i].z <= sourceBase + 1e-8) ordinal = i;
      else break;
    }
    return (ordinal + 1) * this.thickness;
  }

  setOptions(options) {
    Object.assign(this.options, options);
    this.plates.forEach(mesh => {
      mesh.visible = this.options.plates &&
        mesh.userData.ordinal < this.options.count;
    });
    this.buildings.forEach(mesh => { mesh.visible = this.options.buildings; });
    this.model.traverse(object => {
      if (object.userData.isEdge) object.visible = this.options.edges;
    });
    this.render();
  }

  fit() {
    if (!this.project) return;
    const box = new THREE.Box3().setFromObject(this.model);
    if (box.isEmpty()) return;

    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 1);
    const vertical = THREE.MathUtils.degToRad(this.camera.fov / 2);
    const horizontal = Math.atan(Math.tan(vertical) * this.camera.aspect);
    const distance = radius / Math.sin(Math.min(vertical, horizontal)) * 1.15;
    const direction = new THREE.Vector3(1, -1.3, 1).normalize();

    this.camera.position.copy(center).addScaledVector(direction, distance);
    this.camera.near = Math.max(0.001, distance / 10000);
    this.camera.far = distance * 20;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.maxDistance = distance * 10;
    this.controls.update();
    this.render();
  }

  exportBuildingsSTL() {
    if (!this.project || !this.buildings.length) return null;
    const group = new THREE.Group();
    const scale = 1000 / this.project.settings.scale;

    // Fresh mesh wrappers: visibility, edges and the camera cannot affect STL.
    for (const source of this.buildings) {
      const mesh = new THREE.Mesh(source.geometry, source.material);
      mesh.position.copy(source.position);
      group.add(mesh);
    }
    group.scale.setScalar(scale);
    group.updateMatrixWorld(true);
    const binary = new STLExporter().parse(group, { binary: true });
    return new Uint8Array(binary.buffer, binary.byteOffset, binary.byteLength);
  }

  // 3D print by floor: one STL per storey (buildings_floor_XX.stl), every
  // building cut at multiples of floorHeight (m) so floors print flat and stack.
  exportBuildingsSTLByFloor(floorHeight) {
    if (!this.project || !this.project.buildings.length) return {};
    const scale = 1000 / this.project.settings.scale;
    const floors = new Map();
    this.project.buildings.forEach(building => {
      // real storey count from IGN when known (12.2 m single storey = 1 piece)
      const n = building.floors || Math.max(1, Math.round(building.h / floorHeight));
      const step = building.h / n;  // even storeys that add up to h
      const base = this.stackBase(building.base);
      for (let k = 0; k < n; k++) {
        const geometry = new THREE.ExtrudeGeometry(
          buildingShape(building, this.origin),
          { depth: step, bevelEnabled: false, steps: 1, curveSegments: 1 }
        );
        const mesh = new THREE.Mesh(geometry);
        mesh.position.z = base + k * step;
        if (!floors.has(k)) floors.set(k, new THREE.Group());
        floors.get(k).add(mesh);
      }
    });
    const out = {};
    for (const [k, group] of floors) {
      group.scale.setScalar(scale);
      group.updateMatrixWorld(true);
      const binary = new STLExporter().parse(group, { binary: true });
      out[`buildings_floor_${String(k + 1).padStart(2, "0")}.stl`] =
        new Uint8Array(binary.buffer, binary.byteOffset, binary.byteLength);
      group.traverse(o => o.geometry?.dispose());
    }
    return out;
  }

  export3DM(rhino) {
    if (!this.project) throw new Error("생성된 프로젝트가 없습니다.");
    const file = new rhino.File3dm();
    const scale = 1000 / this.project.settings.scale;
    file.settings().modelUnitSystem = rhino.UnitSystem.Millimeters;

    const profile = path => {
      const points = path.getPoints().map(({ x, y }) => [x * scale, y * scale, 0]);
      const polyline = new rhino.Polyline(points.length);
      try {
        for (const point of points) polyline.add(...point);
        return polyline.toPolylineCurve();
      } finally {
        polyline.delete();
      }
    };

    try {
      for (const source of [...this.plates, ...this.buildings]) {
        try {
          const { shapes, options } = source.geometry.parameters;
          const extrusion = new rhino.Extrusion();
          const attributes = new rhino.ObjectAttributes();

          try {
            attributes.name = source.name;
            extrusion.setPathAndUp([0, 0, 0], [0, 0, options.depth * scale], [0, 1, 0]);
            const outer = profile(shapes);
            try {
              if (!extrusion.setOuterProfile(outer, true)) {
                throw new Error(`Rhino 외곽선 생성 실패: ${source.name}`);
              }
            } finally {
              outer.delete();
            }
            for (const hole of shapes.holes) {
              const inner = profile(hole);
              try {
                if (!extrusion.addInnerProfile(inner)) {
                  throw new Error(`Rhino 내부 구멍 생성 실패: ${source.name}`);
                }
              } finally {
                inner.delete();
              }
            }
            const brep = extrusion.toBrep(true);
            try {
              if (!brep?.isValid || !brep.isSolid) {
                throw new Error(`닫힌 Rhino 폴리서피스 생성 실패: ${source.name}`);
              }
              if (source.position.z !== 0) brep.translate([0, 0, source.position.z * scale]);
              file.objects().add(brep, attributes);
            } finally {
              brep?.delete();
            }
          } finally {
            attributes.delete();
            extrusion.delete();
          }
      
        } catch (error) {
          // a degenerate support sliver must not block the whole export
          if (!source.name.startsWith("support_")) throw error;
        }
      }
      return file.toByteArray();
    } finally {
      file.delete();
    }
  }

  exportMetadata() {
    return {
      model_units: "mm",
      source_units: "m",
      source_xy_origin: this.origin,
      horizontal_scale: 1000 / this.project.settings.scale,
      source_layer_z: this.layers.map(layer => layer.z),
      plate_bottom_mm: this.layers.map((_, i) =>
        i * this.project.settings.thickness_mm),
      building_base_rule: "top of last source-z plate at or below building.base",
      building_height_rule: "source h * 1000 / scale",
      stl: "buildings only; Z up; same assembly coordinates as model.3dm",
      model_3dm: "closed Brep solids for all plates and buildings; Z up; assembly coordinates"
    };
  }

  dispose() {
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.clear();
    this.renderer.dispose();
  }
}
