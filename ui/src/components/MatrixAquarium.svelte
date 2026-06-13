<script>
  import { onDestroy, onMount } from "svelte";

  export let temperature = 22;
  export let humidity = 50;
  export let co2 = 420;

  const SIZE = 64;
  const STORAGE_KEY = "livegrid-openmatrix-aquarium-state-v2";
  const NORMAL_TEMPERATURE_C = 22;
  const NORMAL_CO2_PPM = 420;
  const NORMAL_HUMIDITY = 50;

  const CO2_BAD = 1000;
  const CO2_REALBAD = 2000;
  const NUM_FISH_START = 5;
  const NUM_FISH_IDEAL = 20;
  const NUM_PLANTS = 3;
  const BOID_GROUPS = 2;
  const PHYSICS_SCALE = 80;
  const AGE_EGG = 0.1;
  const AGE_CHILD = 0.3;
  const AGE_TEEN = 0.5;
  const AGE_ADULT = 0.7;
  const AGE_SENIOR = 0.9;
  const AGE_DEAD = 1.0;
  const FISH_LIFESPAN_DAYS = 7.0;
  const FISH_LIFESPAN_VARIATION = 1.0;
  const HEALTH_REDUCTION_RATE_BAD = 0.1;
  const HEALTH_REDUCTION_RATE_REALBAD = 0.2;
  const HEALTH_INCREASE_RATE_GOOD = 0.05;

  let canvas;
  let ctx;
  let frameId;
  let lastFrame = 0;
  let lastSave = 0;
  let lastDebugUpdate = 0;
  let debugSnapshot = "";
  let aquarium = {
    fish: [],
    food: [],
    plants: [],
    boidGroups: [],
  };

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (min, max) => min + Math.random() * (max - min);
  const randomInt = (min, max) => Math.floor(rand(min, max + 1));
  const length = (x, y) => Math.hypot(x, y);
  const angleOf = (x, y) => Math.atan2(y, x);
  const fromAngle = (angle, mag = 1) => ({ x: Math.cos(angle) * mag, y: Math.sin(angle) * mag });
  const mapValue = (x, inMin, inMax, outMin, outMax) => ((x - inMin) * (outMax - outMin)) / (inMax - inMin) + outMin;
  const vectorLimit = (vector, max) => {
    const mag = length(vector.x, vector.y);
    if (mag > max && mag > 0) {
      vector.x = (vector.x / mag) * max;
      vector.y = (vector.y / mag) * max;
    }
    return vector;
  };
  const vectorSetMag = (vector, mag) => {
    const current = length(vector.x, vector.y);
    if (current === 0) return vector;
    vector.x = (vector.x / current) * mag;
    vector.y = (vector.y / current) * mag;
    return vector;
  };

  const metricTemperature = () => {
    Number(temperature);
    return NORMAL_TEMPERATURE_C;
  };

  const metricCo2 = () => {
    Number(co2);
    return NORMAL_CO2_PPM;
  };

  const metricHumidity = () => {
    const value = Number(humidity);
    return Number.isFinite(value) && value > 0 ? value : NORMAL_HUMIDITY;
  };

  const hsvToRgb = (input, s = 0.65, v = 1) => {
    const h = typeof input === "object" ? ((input.h ?? 0) / 255) * 360 : input;
    if (typeof input === "object") {
      s = (input.s ?? 166) / 255;
      v = (input.v ?? 255) / 255;
    }
    const c = v * s;
    const hp = (h % 360) / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    let r = 0;
    let g = 0;
    let b = 0;

    if (hp < 1) [r, g, b] = [c, x, 0];
    else if (hp < 2) [r, g, b] = [x, c, 0];
    else if (hp < 3) [r, g, b] = [0, c, x];
    else if (hp < 4) [r, g, b] = [0, x, c];
    else if (hp < 5) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];

    const m = v - c;
    return {
      r: Math.round((r + m) * 255),
      g: Math.round((g + m) * 255),
      b: Math.round((b + m) * 255),
    };
  };

  const colorString = ({ r, g, b }, alpha = 1) => `rgba(${r}, ${g}, ${b}, ${alpha})`;

  const createPalette = (segments, stripes = false) => {
    const baseHue = randomInt(0, 255);
    const hueStep = randomInt(5, 30);
    return Array.from({ length: segments }, (_, index) => {
      let h = (baseHue + index * hueStep) % 256;
      if (stripes && index % 2 === 1) {
        const swapType = randomInt(0, 3);
        if (swapType === 0) h = (h + 85) % 256;
        if (swapType === 1) h = (h + 170) % 256;
      }
      return { h, s: 130, v: 255 };
    });
  };

  const adjustedColor = (fish, index) => {
    const color = fish.palette[index % fish.palette.length] || { h: 120, s: 130, v: 255 };
    let ageFactor = 1;
    if (fish.age >= AGE_ADULT) {
      ageFactor = 1 - ((fish.age - AGE_ADULT) / (AGE_DEAD - AGE_ADULT)) * 0.5;
    }
    return hsvToRgb({
      h: color.h,
      s: 115 * fish.health,
      v: 255 * ageFactor,
    });
  };

  const chooseCreatureType = () => {
    const roll = Math.random();
    if (roll < 0.5) return "Fish";
    if (roll < 0.6) return "Star";
    if (roll < 0.8) return "Turtle";
    if (roll < 0.9) return "Snake";
    return "Octopus";
  };

  const randomHeadType = () => ["TriangleHead", "FrogHead", "NeedleHead"][randomInt(0, 2)];
  const randomTailType = () => ["TriangleTail", "CurvyTail", "WavyTail"][randomInt(0, 2)];
  const randomFinType = () => ["TriangleFin", "EllipseFin", "LegFin", "RoundFin"][randomInt(0, 3)];

  const createMotion = (type) => {
    const settings = {
      Fish: { maxSpeed: 30 / PHYSICS_SCALE, minSpeed: 10 / PHYSICS_SCALE, sinAmplitude: 2 / PHYSICS_SCALE, sinFrequency: 0.002, noise: 6 / PHYSICS_SCALE, side: true },
      Snake: { maxSpeed: 40 / PHYSICS_SCALE, minSpeed: 20 / PHYSICS_SCALE, sinAmplitude: 5 / PHYSICS_SCALE, sinFrequency: 0.005, noise: 6 / PHYSICS_SCALE, side: true },
      Turtle: { maxSpeed: 40 / PHYSICS_SCALE, minSpeed: 5 / PHYSICS_SCALE, sinAmplitude: 10 / PHYSICS_SCALE, sinFrequency: 0.001, noise: 1 / PHYSICS_SCALE, side: false },
      Octopus: { maxSpeed: 35 / PHYSICS_SCALE, minSpeed: 5 / PHYSICS_SCALE, sinAmplitude: 10 / PHYSICS_SCALE, sinFrequency: 0.001, noise: 0, side: false },
      Star: { maxSpeed: 30 / PHYSICS_SCALE, minSpeed: 10 / PHYSICS_SCALE, sinAmplitude: 5 / PHYSICS_SCALE, sinFrequency: 0.005, noise: 2 / PHYSICS_SCALE, side: false },
    }[type];

    const angle = rand(0, Math.PI * 2);
    const speed = rand(settings.minSpeed, settings.maxSpeed);
    return {
      ...settings,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      phase: rand(0, Math.PI * 2),
      noisePhase: rand(0, Math.PI * 2),
    };
  };

  const createFish = ({
    x = rand(0, SIZE),
    y = rand(0, SIZE),
    age = 0,
    health = 1,
    type = chooseCreatureType(),
    headType = randomHeadType(),
    tailType = randomTailType(),
    finType = randomFinType(),
    palette,
  } = {}) => {
    const segmentCount = type === "Snake" ? randomInt(8, 59) : type === "Fish" ? randomInt(4, 11) : randomInt(3, 8);
    const maxAddSize = randomInt(2, 5);
    const segmentSizes = Array.from({ length: segmentCount }, (_, index) => {
      if (type !== "Fish") return 1;
      const phase = (Math.PI * index) / Math.max(1, segmentCount - 1);
      return Math.max(1, 2 + Math.sin(phase) * maxAddSize);
    });
    return {
      id: crypto.randomUUID(),
      type,
      motionType: type,
      headType,
      tailType,
      finType,
      x,
      y,
      age,
      health,
      offspringCount: 0,
      motion: createMotion(type),
      palette: palette || createPalette(segmentCount, type === "Fish"),
      segments: Array.from({ length: segmentCount }, () => ({ x, y })),
      segmentSizes,
      gap: rand(0.7, 0.99),
      size: rand(0.82, 1.18),
      starAngle: rand(0, Math.PI * 2),
      rad: type === "Octopus" ? randomInt(10, 19) : type === "Turtle" ? randomInt(2, 3) : randomInt(2, 3),
      length: type === "Octopus" ? randomInt(10, 24) : type === "Turtle" ? randomInt(4, 9) : randomInt(4, 5),
      arms: randomInt(5, 9),
      tentacles: randomInt(6, 10),
      targetFoodId: null,
      agingRate: (1 / (FISH_LIFESPAN_DAYS * 24 * 60 * 60 * 1000)) * (1 + FISH_LIFESPAN_VARIATION * (rand(0, 2) - 1)),
    };
  };

  const createPlant = (index) => ({
    x: (SIZE * index) / NUM_PLANTS,
    y: SIZE + 7,
    branches: Array.from({ length: randomInt(10, 15) }, () => {
      const branchStart = fromAngle(rand(Math.PI, Math.PI * 2), 3);
      const nodes = [branchStart];
      const nodeCount = randomInt(4, 8);
      for (let i = 1; i < nodeCount; i += 1) {
        const startVec = nodes[i - 1];
        const theta = angleOf(startVec.x, startVec.y);
        const target = (3 * Math.PI) / 2;
        let diff = target - theta;
        if (diff > Math.PI) diff -= Math.PI * 2;
        if (diff < -Math.PI) diff += Math.PI * 2;
        const next = fromAngle(theta + diff * 0.5, 3);
        nodes.push({ x: next.x + startVec.x, y: next.y + startVec.y });
      }
      return {
        nodes,
        phase: rand(0, 5),
      };
    }),
  });

  const createBoid = () => ({
    location: { x: rand(0, SIZE), y: rand(0, SIZE) },
    velocity: { x: mapValue(randomInt(0, 254), 0, 255, -0.5, 0.5), y: mapValue(randomInt(0, 254), 0, 255, -0.5, 0.5) },
    acceleration: { x: 0, y: 0 },
    maxspeed: randomInt(4, 7) / 10,
    maxforce: randomInt(1, 1) / 10,
    desiredseparation: 4,
    neighbordist: 8,
    mass: 1,
    enabled: true,
  });

  const createBoidGroups = () =>
    Array.from({ length: BOID_GROUPS }, () => Array.from({ length: randomInt(10, 19) }, () => createBoid()));

  const createDefaultAquarium = () => ({
    fish: Array.from({ length: NUM_FISH_START }, () => createFish({ age: AGE_TEEN })),
    food: [],
    plants: Array.from({ length: NUM_PLANTS }, (_, index) => createPlant(index)),
    boidGroups: createBoidGroups(),
  });

  const seekBoid = (boid, target) => {
    const desired = { x: target.x - boid.location.x, y: target.y - boid.location.y };
    vectorSetMag(desired, boid.maxspeed);
    const steer = { x: desired.x - boid.velocity.x, y: desired.y - boid.velocity.y };
    return vectorLimit(steer, boid.maxforce);
  };

  const separateBoid = (boid, group) => {
    const steer = { x: 0, y: 0 };
    let count = 0;
    for (const other of group) {
      if (!other.enabled) continue;
      const d = length(boid.location.x - other.location.x, boid.location.y - other.location.y);
      if (d > 0 && d < boid.desiredseparation) {
        const diff = {
          x: (boid.location.x - other.location.x) / d,
          y: (boid.location.y - other.location.y) / d,
        };
        diff.x /= d;
        diff.y /= d;
        steer.x += diff.x;
        steer.y += diff.y;
        count += 1;
      }
    }
    if (count > 0) {
      steer.x /= count;
      steer.y /= count;
    }
    if (length(steer.x, steer.y) > 0) {
      vectorSetMag(steer, boid.maxspeed);
      steer.x -= boid.velocity.x;
      steer.y -= boid.velocity.y;
      vectorLimit(steer, boid.maxforce);
    }
    return steer;
  };

  const alignBoid = (boid, group) => {
    const sum = { x: 0, y: 0 };
    let count = 0;
    for (const other of group) {
      if (!other.enabled) continue;
      const d = length(boid.location.x - other.location.x, boid.location.y - other.location.y);
      if (d > 0 && d < boid.neighbordist) {
        sum.x += other.velocity.x;
        sum.y += other.velocity.y;
        count += 1;
      }
    }
    if (count === 0) return { x: 0, y: 0 };
    sum.x /= count;
    sum.y /= count;
    vectorSetMag(sum, boid.maxspeed);
    return vectorLimit({ x: sum.x - boid.velocity.x, y: sum.y - boid.velocity.y }, boid.maxforce);
  };

  const cohesionBoid = (boid, group) => {
    const sum = { x: 0, y: 0 };
    let count = 0;
    for (const other of group) {
      if (!other.enabled) continue;
      const d = length(boid.location.x - other.location.x, boid.location.y - other.location.y);
      if (d > 0 && d < boid.neighbordist) {
        sum.x += other.location.x;
        sum.y += other.location.y;
        count += 1;
      }
    }
    if (count === 0) return { x: 0, y: 0 };
    sum.x /= count;
    sum.y /= count;
    return seekBoid(boid, sum);
  };

  const updateAndDrawBoids = () => {
    const speedMultiplier = clamp(mapValue(metricCo2(), CO2_BAD, CO2_REALBAD, 100, 0), 0, 100) / 100;
    ctx.strokeStyle = "rgba(50, 200, 100, 0.72)";
    ctx.lineWidth = 0.7;

    for (const group of aquarium.boidGroups) {
      for (const boid of group) {
        const sep = separateBoid(boid, group);
        const ali = alignBoid(boid, group);
        const coh = cohesionBoid(boid, group);
        boid.acceleration.x += sep.x * 1.5 + ali.x + coh.x;
        boid.acceleration.y += sep.y * 1.5 + ali.y + coh.y;
        boid.velocity.x += boid.acceleration.x;
        boid.velocity.y += boid.acceleration.y;
        vectorLimit(boid.velocity, boid.maxspeed * speedMultiplier);
        boid.location.x += boid.velocity.x;
        boid.location.y += boid.velocity.y;
        boid.acceleration.x = 0;
        boid.acceleration.y = 0;

        if (boid.location.x < 0) boid.location.x = SIZE - 1;
        if (boid.location.y < 0) boid.location.y = SIZE - 1;
        if (boid.location.x >= SIZE) boid.location.x = 0;
        if (boid.location.y >= SIZE) boid.location.y = 0;

        const angle = angleOf(boid.velocity.x, boid.velocity.y);
        ctx.beginPath();
        ctx.moveTo(boid.location.x, boid.location.y);
        ctx.lineTo(boid.location.x + Math.cos(angle), boid.location.y + Math.sin(angle));
        ctx.stroke();
      }
    }
  };

  const saveAquarium = () => {
    const saved = {
      fishes: aquarium.fish.map(({ type, headType, tailType, finType, motionType, age, health, palette }) => ({
        age,
        health,
        bodyType: type,
        headType,
        tailType,
        finType,
        motionType,
        colors: palette.map((color) => ({
          h: color.h,
          s: color.s,
          v: color.v,
        })),
      })),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  };

  const loadAquarium = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (!saved?.fishes?.length) return createDefaultAquarium();
      const restored = createDefaultAquarium();
      restored.fish = saved.fishes.map((entry) =>
        createFish({
          age: entry.age,
          health: entry.health,
          type: entry.bodyType,
          headType: entry.headType,
          tailType: entry.tailType,
          finType: entry.finType,
          palette: entry.colors,
        }),
      );
      return restored;
    } catch {
      return createDefaultAquarium();
    }
  };

  const drawBackground = (now) => {
    const temp = clamp(metricTemperature(), 10, 35);
    const heat = (temp - 10) / 25;

    for (let y = 0; y < SIZE; y += 1) {
      const depth = y / SIZE;
      for (let x = 0; x < SIZE; x += 1) {
        const shimmer =
          Math.sin(x * 0.32 + now * 0.002) * 0.5 +
          Math.sin((x + y) * 0.16 + now * 0.0011) * 0.5;
        const cool = { r: 0, g: 62, b: 120 };
        const normal = { r: 0, g: 104, b: 108 };
        const hot = { r: 116, g: 32, b: 18 };
        const mid = heat < 0.6 ? heat / 0.6 : (heat - 0.6) / 0.4;
        const from = heat < 0.6 ? cool : normal;
        const to = heat < 0.6 ? normal : hot;
        const color = {
          r: clamp(lerp(from.r, to.r, mid) + shimmer * 4, 0, 255),
          g: clamp(lerp(from.g, to.g, mid) - depth * 35 + shimmer * 7, 18, 255),
          b: clamp(lerp(from.b, to.b, mid) - depth * 28 + shimmer * 4, 18, 255),
        };
        ctx.fillStyle = colorString(color);
        ctx.fillRect(x, y, 1, 1);
      }
    }

    ctx.fillStyle = "rgba(255,255,255,0.06)";
    for (let x = -SIZE; x < SIZE * 2; x += 10) {
      ctx.fillRect(x + Math.sin(now * 0.001 + x) * 1.8, 5 + Math.sin(now * 0.0013 + x) * 1.2, 6, 1);
    }
  };

  const drawPlants = (now) => {
    const sizeFactor = clamp(mapValue(metricHumidity(), 0, 100, 0, 250) / 100, 0, 2.5);
    ctx.lineCap = "round";

    for (const plant of aquarium.plants) {
      for (const branch of plant.branches) {
        const baseX = plant.x;
        const baseY = plant.y;
        let previous = {
          x: branch.nodes[0].x * sizeFactor + baseX,
          y: branch.nodes[0].y * sizeFactor + baseY,
        };

        for (let index = 1; index < branch.nodes.length; index += 1) {
          const node = branch.nodes[index];
          const prevNode = branch.nodes[index - 1];
          const sway = Math.sin(now / 10000 + branch.phase) * (0.8 * index);
          const next = {
            x: baseX + node.x * sizeFactor + sway,
            y: baseY + node.y * sizeFactor,
          };
          previous = {
            x: baseX + prevNode.x * sizeFactor + sway,
            y: baseY + prevNode.y * sizeFactor,
          };

          ctx.strokeStyle = "rgba(0, 90, 64, 0.9)";
          ctx.lineWidth = 0.7;
          ctx.beginPath();
          ctx.moveTo(previous.x, previous.y);
          ctx.lineTo(next.x, next.y);
          ctx.stroke();

          if (index === branch.nodes.length - 1 && Math.sin(now * 0.001 + branch.phase) > 0.78) {
            ctx.fillStyle = "rgba(245, 221, 77, 0.92)";
            ctx.fillRect(Math.round(next.x), Math.round(next.y), 1, 1);
          }
        }
      }
    }
  };

  const updateFood = (delta) => {
    aquarium.food = aquarium.food
      .map((piece) => ({
        ...piece,
        y: piece.y + delta * 0.018,
        pulse: piece.pulse + delta * 0.01,
      }))
      .filter((piece) => piece.y < SIZE && !piece.eaten);
  };

  const drawFood = () => {
    for (const piece of aquarium.food) {
      ctx.fillStyle = Math.sin(piece.pulse) > 0 ? "rgb(255, 234, 98)" : "rgb(255, 198, 34)";
      ctx.fillRect(Math.round(piece.x), Math.round(piece.y), 1, 1);
    }
  };

  const applyBoundary = (fish, force = 0.004) => {
    if (fish.x < 2) fish.motion.vx += force;
    if (fish.y < 2) fish.motion.vy += force;
    if (fish.x > SIZE - 2) fish.motion.vx -= force;
    if (fish.y > SIZE - 2) fish.motion.vy -= force;
  };

  const updateFishMotion = (fish, delta, now) => {
    const motion = fish.motion;
    const currentCo2 = metricCo2();

    if (fish.age < AGE_EGG) {
      return;
    }

    applyBoundary(fish, currentCo2 > CO2_BAD ? 0.02 : 0.005);
    const targetFood = aquarium.food.find((piece) => piece.id === fish.targetFoodId);

    if (targetFood) {
      const dx = targetFood.x - fish.x;
      const dy = targetFood.y - fish.y;
      const distance = Math.max(0.001, length(dx, dy));
      motion.vx += (dx / distance) * 0.08 * delta;
      motion.vy += (dy / distance) * 0.08 * delta;
      if (distance < 1.8) {
        targetFood.eaten = true;
        fish.health = 1;
        fish.targetFoodId = null;
      }
    } else {
      fish.targetFoodId = null;
      const heading = angleOf(motion.vx, motion.vy);
      const sideAngle = heading + (motion.side ? Math.PI / 2 : 0);
      const sine = Math.sin(now * motion.sinFrequency + motion.phase) * motion.sinAmplitude;
      const noiseAngle = Math.sin(fish.x * 0.19 + now * 0.0013 + motion.noisePhase) * Math.PI * 2;
      const sineForce = fromAngle(sideAngle, sine * delta);
      const noiseForce = fromAngle(noiseAngle, motion.noise * delta);
      motion.vx += sineForce.x + noiseForce.x;
      motion.vy += sineForce.y + noiseForce.y;
    }

    let maxSpeed = motion.maxSpeed;
    if (currentCo2 > CO2_BAD) {
      maxSpeed = clamp(((CO2_REALBAD - currentCo2) / (CO2_REALBAD - CO2_BAD)) * motion.maxSpeed, 0, motion.maxSpeed);
    }

    const speed = length(motion.vx, motion.vy);
    if (speed < motion.minSpeed) {
      const angle = speed ? angleOf(motion.vx, motion.vy) : rand(0, Math.PI * 2);
      motion.vx = Math.cos(angle) * motion.minSpeed;
      motion.vy = Math.sin(angle) * motion.minSpeed;
    } else if (speed > maxSpeed) {
      motion.vx = (motion.vx / speed) * maxSpeed;
      motion.vy = (motion.vy / speed) * maxSpeed;
    }

    fish.x += motion.vx * delta;
    fish.y += motion.vy * delta;
  };

  const updateFishLife = (fish, delta) => {
    const currentCo2 = metricCo2();
    if (currentCo2 < CO2_REALBAD) fish.age += delta * fish.agingRate;
    if (currentCo2 >= CO2_REALBAD) fish.health -= HEALTH_REDUCTION_RATE_REALBAD;
    else if (currentCo2 >= CO2_BAD) fish.health -= HEALTH_REDUCTION_RATE_BAD;
    else fish.health += HEALTH_INCREASE_RATE_GOOD;
    fish.health = clamp(fish.health, 0, 1);
    if (fish.age > AGE_DEAD) fish.age = 0;
  };

  const drawEgg = (fish) => {
    const color = hsvToRgb(fish.palette[0] || 200, 0.5, 1);
    ctx.fillStyle = colorString(color, 0.92);
    ctx.fillRect(Math.round(fish.x), Math.round(fish.y), 1, 1);
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.fillRect(Math.round(fish.x), Math.round(fish.y - 1), 1, 1);
  };

  const fillTriangle = (a, b, c, color) => {
    ctx.fillStyle = colorString(color);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.lineTo(c.x, c.y);
    ctx.closePath();
    ctx.fill();
  };

  const drawCircleArray = (x, y, radius, lengthToDraw, angle, color) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.fillStyle = colorString(color);
    ctx.beginPath();
    ctx.ellipse(0, 0, Math.max(0.5, lengthToDraw), Math.max(0.5, radius), 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };

  const drawHead = (type, position, angle, size, color) => {
    if (type === "FrogHead") {
      const heading = fromAngle(angle, 0.5);
      const p1 = fromAngle(angle + Math.PI / 2, size);
      const p2 = fromAngle(angle + Math.PI / 2, -size);
      const frogColor = { r: color.b, g: color.g, b: color.r };
      ctx.fillStyle = colorString(frogColor);
      ctx.beginPath();
      ctx.arc(position.x + heading.x + p1.x, position.y + heading.y + p1.y, Math.max(0.5, size / 2), 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(position.x + heading.x + p2.x, position.y + heading.y + p2.y, Math.max(0.5, size / 2), 0, Math.PI * 2);
      ctx.fill();
      return;
    }

    if (type === "NeedleHead") {
      const nose = fromAngle(angle, size * 4);
      ctx.strokeStyle = colorString(color);
      ctx.lineWidth = 0.85;
      ctx.beginPath();
      ctx.moveTo(position.x, position.y);
      ctx.lineTo(position.x + nose.x, position.y + nose.y);
      ctx.stroke();
      return;
    }

    const shift = fromAngle(angle + Math.PI, size * 0.25);
    const shifted = { x: position.x + shift.x, y: position.y + shift.y };
    fillTriangle(
      { x: shifted.x + Math.cos(angle) * size, y: shifted.y + Math.sin(angle) * size },
      { x: shifted.x + Math.cos(angle - Math.PI / 2) * (size / 2), y: shifted.y + Math.sin(angle - Math.PI / 2) * (size / 2) },
      { x: shifted.x + Math.cos(angle + Math.PI / 2) * (size / 2), y: shifted.y + Math.sin(angle + Math.PI / 2) * (size / 2) },
      color,
    );
  };

  const drawTail = (type, position, angle, size, color) => {
    if (type === "CurvyTail") {
      drawCircleArray(position.x, position.y, size / 3, size * 3, angle + Math.PI / 2, color);
      return;
    }
    if (type === "WavyTail") {
      ctx.strokeStyle = colorString(color);
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(position.x, position.y);
      for (let i = 1; i < 8; i += 1) {
        const p = fromAngle(angle + Math.PI, i);
        const side = fromAngle(angle + Math.PI / 2, Math.sin(performance.now() * 0.012 + i) * 1.4);
        ctx.lineTo(position.x + p.x + side.x, position.y + p.y + side.y);
      }
      ctx.stroke();
      return;
    }
    const heading = fromAngle(angle, 1);
    const pt1 = fromAngle(angle, size);
    const pt2 = fromAngle(angle, -size);
    const back = { x: heading.x * 3, y: heading.y * 3 };
    const pt3a = fromAngle(angle + Math.PI / 2, size * 3);
    const pt3b = fromAngle(angle + Math.PI / 2, -size * 3);
    fillTriangle(
      { x: position.x + pt1.x, y: position.y + pt1.y },
      { x: position.x + pt2.x, y: position.y + pt2.y },
      { x: position.x + pt3a.x - back.x, y: position.y + pt3a.y - back.y },
      color,
    );
    fillTriangle(
      { x: position.x + pt1.x, y: position.y + pt1.y },
      { x: position.x + pt2.x, y: position.y + pt2.y },
      { x: position.x + pt3b.x - back.x, y: position.y + pt3b.y - back.y },
      color,
    );
  };

  const drawFin = (type, position, angle, size, color) => {
    if (type === "EllipseFin") {
      drawCircleArray(position.x, position.y, size * 3, size / 3, angle, color);
      return;
    }
    if (type === "LegFin" || type === "RoundFin") {
      const p1 = fromAngle(angle + Math.PI / 2, size * 2);
      const p2 = fromAngle(angle + Math.PI / 2, -size * 2);
      ctx.strokeStyle = colorString(color);
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(position.x, position.y);
      ctx.lineTo(position.x + p1.x, position.y + p1.y);
      ctx.moveTo(position.x, position.y);
      ctx.lineTo(position.x + p2.x, position.y + p2.y);
      ctx.stroke();
      if (type === "RoundFin") {
        ctx.fillStyle = colorString({ r: color.b, g: color.g, b: color.r });
        ctx.beginPath();
        ctx.arc(position.x + p1.x, position.y + p1.y, Math.max(0.5, size / 3), 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(position.x + p2.x, position.y + p2.y, Math.max(0.5, size / 3), 0, Math.PI * 2);
        ctx.fill();
      }
      return;
    }
    const heading = fromAngle(angle, 1);
    const pt1 = fromAngle(angle, size);
    const pt2 = fromAngle(angle, -size / 2);
    const back = { x: heading.x * 3, y: heading.y * 3 };
    const pt3a = fromAngle(angle + Math.PI / 2, size * 2);
    const pt3b = fromAngle(angle + Math.PI / 2, -size * 2);
    fillTriangle(
      { x: position.x + pt1.x, y: position.y + pt1.y },
      { x: position.x + pt2.x, y: position.y + pt2.y },
      { x: position.x + pt3a.x - back.x, y: position.y + pt3a.y - back.y },
      color,
    );
    fillTriangle(
      { x: position.x + pt1.x, y: position.y + pt1.y },
      { x: position.x + pt2.x, y: position.y + pt2.y },
      { x: position.x + pt3b.x - back.x, y: position.y + pt3b.y - back.y },
      color,
    );
  };

  const drawSegmentedFish = (fish) => {
    const angle = angleOf(fish.motion.vx, fish.motion.vy);
    const ageScale = clamp(fish.age, 0, 1) * fish.size;

    fish.segments[0] = { x: fish.x, y: fish.y };
    for (let index = 1; index < fish.segments.length; index += 1) {
      const previous = fish.segments[index - 1];
      const current = fish.segments[index];
      const dx = previous.x - current.x;
      const dy = previous.y - current.y;
      const segmentAngle = angleOf(dx, dy);
      const maxSegmentSize = Math.max(fish.segmentSizes[index - 1] || 1, fish.segmentSizes[index] || 1) * ageScale * fish.gap;
      fish.segments[index] = {
        x: previous.x - Math.cos(segmentAngle) * maxSegmentSize,
        y: previous.y - Math.sin(segmentAngle) * maxSegmentSize,
      };
    }

    for (let index = fish.segments.length - 1; index >= 0; index -= 1) {
      const segment = fish.segments[index];
      const color = adjustedColor(fish, index);
      const radius = Math.max(0.7, (fish.segmentSizes[index] || 1) * ageScale);
      if ((index === 1 || index === 3) && fish.finType) {
        drawFin(fish.finType, segment, angle, radius, color);
      }
      if (index === fish.segments.length - 1 && fish.tailType) {
        drawTail(fish.tailType, segment, angle, radius * 2, color);
        continue;
      }
      ctx.fillStyle = colorString(color);
      ctx.beginPath();
      ctx.arc(segment.x, segment.y, radius, 0, Math.PI * 2);
      ctx.fill();
    }

    const headColor = adjustedColor(fish, 0);
    drawHead(fish.headType, { x: fish.x, y: fish.y }, angle, Math.max(1, (fish.segmentSizes[0] || 2) * ageScale), headColor);
  };

  const drawSnake = (fish) => {
    const ageScale = clamp(fish.age / AGE_ADULT, 0.25, 1.1);
    fish.segments[0] = { x: fish.x, y: fish.y };
    for (let index = 1; index < fish.segments.length; index += 1) {
      const previous = fish.segments[index - 1];
      const current = fish.segments[index];
      const segmentAngle = angleOf(previous.x - current.x, previous.y - current.y);
      fish.segments[index] = {
        x: previous.x - Math.cos(segmentAngle) * 1.2,
        y: previous.y - Math.sin(segmentAngle) * 1.2,
      };
    }

    const visible = Math.max(3, Math.floor(fish.segments.length * ageScale));
    for (let index = visible - 1; index >= 0; index -= 1) {
      const segment = fish.segments[index];
      ctx.fillStyle = colorString(adjustedColor(fish, index));
      ctx.fillRect(Math.round(segment.x), Math.round(segment.y), index < 3 ? 2 : 1, 1);
    }
  };

  const drawTurtle = (fish) => {
    const angle = angleOf(fish.motion.vx, fish.motion.vy);
    const ageScale = clamp(fish.age / AGE_ADULT, 0.22, 1.15) * fish.size;
    const shell = adjustedColor(fish, 0);

    ctx.save();
    ctx.translate(fish.x, fish.y);
    ctx.rotate(angle);
    ctx.fillStyle = colorString(shell);
    ctx.beginPath();
    ctx.ellipse(0, 0, fish.length * 0.48 * ageScale, fish.rad * 0.45 * ageScale, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = colorString(adjustedColor(fish, 1));
    ctx.fillRect(Math.round(fish.length * 0.34 * ageScale), -1, 2, 2);
    ctx.fillRect(-1, -Math.round(fish.rad * 0.58 * ageScale), 2, 1);
    ctx.fillRect(-1, Math.round(fish.rad * 0.48 * ageScale), 2, 1);
    ctx.restore();
  };

  const drawStar = (fish, now) => {
    const ageScale = clamp(fish.age / AGE_ADULT, 0.22, 1.1) * fish.size;
    fish.starAngle += Math.max(length(fish.motion.vx, fish.motion.vy), 0.04) * 0.04;
    const color = adjustedColor(fish, 0);
    const nodeColor = adjustedColor(fish, 1);

    ctx.strokeStyle = colorString(color);
    ctx.fillStyle = colorString(nodeColor);
    ctx.lineWidth = 0.8;
    for (let arm = 0; arm < fish.arms; arm += 1) {
      const armAngle = fish.starAngle + (Math.PI * 2 * arm) / fish.arms;
      const endpoint = fromAngle(armAngle, fish.length * 0.62 * ageScale);
      ctx.beginPath();
      ctx.moveTo(fish.x, fish.y);
      ctx.lineTo(fish.x + endpoint.x, fish.y + endpoint.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(fish.x + endpoint.x, fish.y + endpoint.y, Math.max(0.8, fish.rad * 0.22 * ageScale), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = colorString(color);
    ctx.beginPath();
    ctx.arc(fish.x, fish.y, Math.max(1, fish.rad * 0.28 * ageScale + Math.sin(now * 0.004) * 0.15), 0, Math.PI * 2);
    ctx.fill();
  };

  const drawOctopus = (fish, now) => {
    const angle = angleOf(fish.motion.vx, fish.motion.vy);
    const ageScale = clamp(fish.age / AGE_ADULT, 0.2, 1.1) * fish.size;
    const bodyColor = adjustedColor(fish, 0);

    ctx.save();
    ctx.translate(fish.x, fish.y);
    ctx.rotate(angle);
    ctx.fillStyle = colorString(bodyColor);
    ctx.beginPath();
    ctx.ellipse(0, 0, fish.rad * 0.38 * ageScale, fish.rad * 0.52 * ageScale, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = colorString(bodyColor, 0.92);
    ctx.lineWidth = 0.8;
    for (let arm = 0; arm < fish.tentacles; arm += 1) {
      const spread = -Math.PI * 0.8 + (arm / Math.max(1, fish.tentacles - 1)) * Math.PI * 1.6;
      const start = fromAngle(Math.PI + spread * 0.16, fish.rad * 0.28 * ageScale);
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      const mid = fromAngle(Math.PI + spread * 0.35 + Math.sin(now * 0.006 + arm) * 0.24, fish.length * 0.34 * ageScale);
      const end = fromAngle(Math.PI + spread * 0.55 + Math.sin(now * 0.007 + arm) * 0.4, fish.length * 0.56 * ageScale);
      ctx.quadraticCurveTo(mid.x, mid.y, end.x, end.y);
      ctx.stroke();
    }
    ctx.restore();
  };

  const drawCreature = (fish, now) => {
    if (fish.age < AGE_EGG) {
      drawEgg(fish);
      return;
    }
    if (fish.type === "Snake") drawSnake(fish);
    else if (fish.type === "Turtle") drawTurtle(fish);
    else if (fish.type === "Star") drawStar(fish, now);
    else if (fish.type === "Octopus") drawOctopus(fish, now);
    else drawSegmentedFish(fish);
  };

  const maybeReproduce = () => {
    if (aquarium.fish.length >= NUM_FISH_IDEAL) return;
    for (const fish of aquarium.fish) {
      if (fish.age > AGE_TEEN && fish.age < AGE_SENIOR && fish.offspringCount < 2 && Math.random() < 0.01) {
        fish.offspringCount += 1;
        aquarium.fish.push(
          createFish({
            x: fish.x,
            y: fish.y,
          }),
        );
        break;
      }
    }
  };

  const updateCreatures = (delta, now) => {
    if (aquarium.fish.length < NUM_FISH_START) {
      aquarium.fish.push(createFish({ age: AGE_TEEN }));
    }

    for (const fish of aquarium.fish) {
      updateFishLife(fish, delta);
      updateFishMotion(fish, delta / 16.67, now);
      drawCreature(fish, now);
    }
    maybeReproduce();
  };

  const render = (now) => {
    if (!lastFrame) lastFrame = now;
    const delta = Math.min(80, now - lastFrame);
    lastFrame = now;

    drawBackground(now);
    updateAndDrawBoids();
    updateCreatures(delta, now);
    updateFood(delta);
    drawFood();
    drawPlants(now);

    if (now - lastSave > 30000) {
      lastSave = now;
      saveAquarium();
    }

    if (now - lastDebugUpdate > 500) {
      lastDebugUpdate = now;
      debugSnapshot = JSON.stringify({
        fishCount: aquarium.fish.length,
        foodCount: aquarium.food.length,
        plantCount: aquarium.plants.length,
        boidGroups: aquarium.boidGroups.map((group) => group.length),
        temperature: metricTemperature(),
        co2: metricCo2(),
        fishes: aquarium.fish.map((fish) => ({
          bodyType: fish.type,
          headType: fish.headType,
          tailType: fish.tailType,
          finType: fish.finType,
          motionType: fish.motionType,
          age: fish.age,
          health: fish.health,
          targetFoodId: fish.targetFoodId,
        })),
      });
    }

    frameId = requestAnimationFrame(render);
  };

  const addFood = () => {
    const foodPiece = { id: crypto.randomUUID(), x: rand(0, SIZE), y: 0, pulse: 0, eaten: false };
    aquarium.food.push(foodPiece);
    aquarium.food = aquarium.food.slice(-16);

    let closestFish = null;
    let minDistance = Number.POSITIVE_INFINITY;
    for (const fish of aquarium.fish) {
      if (fish.targetFoodId || fish.age <= AGE_EGG || fish.age >= AGE_SENIOR) continue;
      const distance = length(foodPiece.x - fish.x, foodPiece.y - fish.y);
      if (distance < minDistance) {
        minDistance = distance;
        closestFish = fish;
      }
    }
    if (closestFish) {
      closestFish.targetFoodId = foodPiece.id;
    }
  };

  const feed = () => {
    addFood();
  };

  onMount(() => {
    ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    aquarium = loadAquarium();
    frameId = requestAnimationFrame(render);
  });

  onDestroy(() => {
    cancelAnimationFrame(frameId);
    saveAquarium();
  });
</script>

<div class="relative overflow-hidden rounded-md border border-zinc-200 bg-zinc-950 p-3 shadow-sm dark:border-zinc-900">
  <div class="matrix-bezel mx-auto">
    <canvas
      bind:this={canvas}
      on:pointerdown={feed}
      width={SIZE}
      height={SIZE}
      class="matrix-canvas"
      aria-label="Livegrid aquarium ecosystem"
      data-debug={debugSnapshot}
    ></canvas>
  </div>

  <div class="pointer-events-none absolute right-5 top-5 flex items-center gap-2 rounded-full border border-white/10 bg-black/40 px-3 py-1 text-xs font-medium text-emerald-100 backdrop-blur">
    <span>{metricTemperature().toFixed(0)} °C</span>
    <span class="h-1 w-1 rounded-full bg-emerald-300"></span>
    <span>{metricCo2().toFixed(0)} ppm</span>
  </div>
</div>

<style>
  .matrix-bezel {
    width: min(100%, 720px);
    aspect-ratio: 1 / 1;
    padding: clamp(10px, 2vw, 18px);
    border-radius: 8px;
    background:
      linear-gradient(145deg, rgba(255, 255, 255, 0.08), transparent 32%),
      #06080a;
    box-shadow:
      inset 0 0 0 1px rgba(255, 255, 255, 0.06),
      inset 0 0 36px rgba(0, 0, 0, 0.9),
      0 24px 70px rgba(0, 0, 0, 0.34);
  }

  .matrix-canvas {
    display: block;
    width: 100%;
    height: 100%;
    border-radius: 4px;
    cursor: crosshair;
    image-rendering: pixelated;
    image-rendering: crisp-edges;
    background: #00161a;
    box-shadow:
      inset 0 0 0 1px rgba(255, 255, 255, 0.06),
      0 0 34px rgba(20, 184, 166, 0.18);
  }
</style>
