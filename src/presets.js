// Starter Character Presets (Grid-Snapped Bodies, Hinged Flaps, Area Extrudes & Animation Pins)

export const PRESETS = {
  bear: {
    name: 'BEAR HEAD (FLAPS)',
    gridRes: 24,
    meshMode: 'full',
    lowPolyDetail: 8,
    depth: 0.36,
    roundness: 0.58,
    shadingMode: 'clay',
    strokes: [
      {
        id: 'bear_head',
        name: 'HEAD',
        type: 'closed',
        flapSide: 'sym',
        color: '#d97724',
        visible: true,
        partDepth: 1.0,
        partPuff: 1.0,
        points: [
          { gx: 7, gy: 6 }, { gx: 10, gy: 4 }, { gx: 14, gy: 4 }, { gx: 17, gy: 6 },
          { gx: 19, gy: 9 }, { gx: 19, gy: 15 }, { gx: 17, gy: 18 }, { gx: 14, gy: 19 },
          { gx: 10, gy: 19 }, { gx: 7, gy: 18 }, { gx: 5, gy: 15 }, { gx: 5, gy: 9 },
        ],
      },
      {
        id: 'bear_ear_l',
        name: 'EAR L',
        type: 'flap',
        flapSide: 'sym',
        flapAttach: 0,
        color: '#c25e10',
        visible: true,
        partDepth: 0.9,
        partPuff: 1.0,
        points: [
          { gx: 8, gy: 6 }, { gx: 5, gy: 3 }, { gx: 3, gy: 4 }, { gx: 3, gy: 7 }, { gx: 6, gy: 9 },
        ],
      },
      {
        id: 'bear_ear_r',
        name: 'EAR R',
        type: 'flap',
        flapSide: 'sym',
        flapAttach: 0,
        color: '#c25e10',
        visible: true,
        partDepth: 0.9,
        partPuff: 1.0,
        points: [
          { gx: 16, gy: 6 }, { gx: 19, gy: 3 }, { gx: 21, gy: 4 }, { gx: 21, gy: 7 }, { gx: 18, gy: 9 },
        ],
      },
      {
        id: 'bear_snout',
        name: 'SNOUT',
        type: 'extrude',
        flapSide: 'front',
        color: '#f5b062',
        visible: true,
        partDepth: 0.85,
        partPuff: 0.9,
        points: [
          { gx: 9, gy: 12 }, { gx: 12, gy: 11 }, { gx: 15, gy: 12 },
          { gx: 16, gy: 15 }, { gx: 14, gy: 17 }, { gx: 10, gy: 17 }, { gx: 8, gy: 15 },
        ],
      },
      {
        id: 'bear_tuft',
        name: 'TUFT FLAP',
        type: 'flap',
        flapSide: 'front',
        flapAttach: 35,
        color: '#e58d35',
        visible: true,
        partDepth: 0.85,
        partPuff: 1.0,
        points: [
          { gx: 10, gy: 5 }, { gx: 11, gy: 9 }, { gx: 13, gy: 9 }, { gx: 14, gy: 5 },
        ],
      },
    ],
    // Paint eyes & nose onto 2:1 front atlas half (width = 2*uvRes, height = uvRes)
    paintFn: (uvPainter) => {
      const ctx = uvPainter.texCtx;
      const s = uvPainter.texCanvas.height / 64;
      // Front half center is x = 32*s
      ctx.fillStyle = '#141414';
      ctx.fillRect(Math.round(25 * s), Math.round(25 * s), Math.round(3 * s), Math.round(3 * s));
      ctx.fillRect(Math.round(37 * s), Math.round(25 * s), Math.round(3 * s), Math.round(3 * s));
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(Math.round(25 * s), Math.round(25 * s), Math.round(1 * s), Math.round(1 * s));
      ctx.fillRect(Math.round(37 * s), Math.round(25 * s), Math.round(1 * s), Math.round(1 * s));
      ctx.fillStyle = '#291509';
      ctx.fillRect(Math.round(30 * s), Math.round(34 * s), Math.round(5 * s), Math.round(3 * s));
    },
    pins: [
      { id: 'p_chin', rest: [0, -0.42, 0.15], pos: [0, -0.42, 0.15], anchor: true, keys: {} },
      {
        id: 'p_ear_l',
        rest: [-0.67, 0.58, 0.0],
        pos: [-0.67, 0.58, 0.0],
        anchor: false,
        keys: {
          0: [-0.67, 0.58, 0.0],
          15: [-0.74, 0.74, 0.08],
          30: [-0.67, 0.54, 0.0],
          45: [-0.61, 0.70, -0.06],
        },
      },
      {
        id: 'p_ear_r',
        rest: [0.67, 0.58, 0.0],
        pos: [0.67, 0.58, 0.0],
        anchor: false,
        keys: {
          0: [0.67, 0.58, 0.0],
          15: [0.74, 0.74, 0.08],
          30: [0.67, 0.54, 0.0],
          45: [0.61, 0.70, -0.06],
        },
      },
    ],
  },

  blocky: {
    name: 'CHIBI HERO (LOW-POLY)',
    gridRes: 32,
    meshMode: 'lowpoly',
    lowPolyDetail: 6,
    depth: 0.30,
    roundness: 0.72,
    shadingMode: 'faceted',
    strokes: [
      {
        id: 'ch_body',
        name: 'TUNIC BODY',
        type: 'closed',
        partRole: 'body',
        flapSide: 'sym',
        color: '#e7e1d1',
        visible: true,
        partDepth: 0.90,
        partPuff: 0.95,
        points: [
          { gx: 13, gy: 13 }, { gx: 19, gy: 13 },
          { gx: 18, gy: 16 }, { gx: 20, gy: 22 },
          { gx: 12, gy: 22 }, { gx: 14, gy: 16 },
        ],
      },
      {
        id: 'ch_head',
        name: 'HEAD',
        type: 'closed',
        partRole: 'head',
        flapSide: 'sym',
        color: '#f5d5b8',
        visible: true,
        partDepth: 1.10,
        partPuff: 1.0,
        points: [
          { gx: 12, gy: 3 }, { gx: 20, gy: 3 },
          { gx: 22, gy: 6 }, { gx: 21, gy: 10 },
          { gx: 19, gy: 12 }, { gx: 16, gy: 13 },
          { gx: 13, gy: 12 }, { gx: 11, gy: 10 }, { gx: 10, gy: 6 },
        ],
      },
      {
        id: 'ch_hair_front',
        name: 'BANGS',
        type: 'flap',
        partRole: 'flap',
        flapSide: 'front',
        flapAttach: 45,
        color: '#3a2d28',
        visible: true,
        partDepth: 0.65,
        partPuff: 0.85,
        points: [
          { gx: 11, gy: 5 }, { gx: 11, gy: 8 },
          { gx: 13, gy: 6 }, { gx: 16, gy: 8 },
          { gx: 19, gy: 6 }, { gx: 21, gy: 8 }, { gx: 21, gy: 5 },
        ],
      },
      {
        id: 'ch_hair_l',
        name: 'HAIR L',
        type: 'flap',
        partRole: 'flap',
        flapSide: 'sym',
        flapAttach: 30,
        color: '#3a2d28',
        visible: true,
        partDepth: 0.70,
        partPuff: 0.85,
        points: [
          { gx: 11, gy: 5 }, { gx: 9, gy: 7 }, { gx: 9, gy: 13 }, { gx: 11, gy: 14 }, { gx: 11, gy: 9 },
        ],
      },
      {
        id: 'ch_hair_r',
        name: 'HAIR R',
        type: 'flap',
        partRole: 'flap',
        flapSide: 'sym',
        flapAttach: 30,
        color: '#3a2d28',
        visible: true,
        partDepth: 0.70,
        partPuff: 0.85,
        points: [
          { gx: 21, gy: 5 }, { gx: 23, gy: 7 }, { gx: 23, gy: 13 }, { gx: 21, gy: 14 }, { gx: 21, gy: 9 },
        ],
      },
      {
        id: 'ch_ribbon_l',
        name: 'CREST L',
        type: 'flap',
        partRole: 'flap',
        flapSide: 'sym',
        flapAttach: 0,
        color: '#f5eedc',
        visible: true,
        partDepth: 0.55,
        partPuff: 0.85,
        points: [
          { gx: 15, gy: 3 }, { gx: 13, gy: 1 }, { gx: 15, gy: 1 }, { gx: 16, gy: 3 },
        ],
      },
      {
        id: 'ch_ribbon_r',
        name: 'CREST R',
        type: 'flap',
        partRole: 'flap',
        flapSide: 'sym',
        flapAttach: 0,
        color: '#f5eedc',
        visible: true,
        partDepth: 0.55,
        partPuff: 0.85,
        points: [
          { gx: 17, gy: 3 }, { gx: 19, gy: 1 }, { gx: 17, gy: 1 }, { gx: 16, gy: 3 },
        ],
      },
      {
        id: 'ch_arm_l',
        name: 'ARM L',
        type: 'flap',
        partRole: 'limb',
        flapSide: 'sym',
        flapAttach: 0,
        color: '#f5d5b8',
        visible: true,
        partDepth: 0.95,
        partPuff: 1.0,
        points: [
          { gx: 14, gy: 13 }, { gx: 9, gy: 17 }, { gx: 8, gy: 19 }, { gx: 10, gy: 19 }, { gx: 14, gy: 15 },
        ],
      },
      {
        id: 'ch_arm_r',
        name: 'ARM R',
        type: 'flap',
        partRole: 'limb',
        flapSide: 'sym',
        flapAttach: 0,
        color: '#f5d5b8',
        visible: true,
        partDepth: 0.95,
        partPuff: 1.0,
        points: [
          { gx: 18, gy: 13 }, { gx: 23, gy: 17 }, { gx: 24, gy: 19 }, { gx: 22, gy: 19 }, { gx: 18, gy: 15 },
        ],
      },
      {
        id: 'ch_leg_l',
        name: 'LEG L',
        type: 'flap',
        partRole: 'limb',
        flapSide: 'sym',
        flapAttach: 0,
        color: '#1e293b',
        visible: true,
        partDepth: 0.95,
        partPuff: 1.0,
        points: [
          { gx: 13, gy: 21 }, { gx: 12, gy: 26 }, { gx: 13, gy: 30 }, { gx: 15, gy: 30 }, { gx: 15, gy: 21 },
        ],
      },
      {
        id: 'ch_leg_r',
        name: 'LEG R',
        type: 'flap',
        partRole: 'limb',
        flapSide: 'sym',
        flapAttach: 0,
        color: '#1e293b',
        visible: true,
        partDepth: 0.95,
        partPuff: 1.0,
        points: [
          { gx: 17, gy: 21 }, { gx: 17, gy: 30 }, { gx: 19, gy: 30 }, { gx: 20, gy: 26 }, { gx: 19, gy: 21 },
        ],
      },
    ],
    paintFn: (uvPainter) => {
      const ctx = uvPainter.texCtx;
      const H = uvPainter.texCanvas.height;
      const W = uvPainter.texCanvas.width;
      const s = H / 64;
      const pxF = (gx, gy) => ({
        x: Math.round((0.02 + (gx / 32) * 0.46) * W),
        y: Math.round((0.04 + (gy / 32) * 0.92) * H),
      });
      const pxB = (gx, gy) => ({
        x: Math.round((0.52 + (1 - gx / 32) * 0.46) * W),
        y: Math.round((0.04 + (gy / 32) * 0.92) * H),
      });

      // Back hair block
      const bh0 = pxB(22, 3), bh1 = pxB(10, 14);
      ctx.fillStyle = '#3a2d28';
      ctx.fillRect(Math.min(bh0.x, bh1.x), bh0.y, Math.abs(bh1.x - bh0.x), bh1.y - bh0.y);

      // Anime Chibi Eyes (front face)
      const eL = pxF(12.6, 8.2);
      const eR = pxF(17.4, 8.2);
      const ew = Math.max(2, Math.round(3.6 * s));
      const eh = Math.max(2, Math.round(3.2 * s));
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(eL.x, eL.y, ew, eh);
      ctx.fillRect(eR.x, eR.y, ew, eh);
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(eL.x + Math.round(0.8 * s), eL.y, Math.max(1, ew - Math.round(1.0 * s)), eh);
      ctx.fillRect(eR.x + Math.round(0.2 * s), eR.y, Math.max(1, ew - Math.round(1.0 * s)), eh);
      // Eye brows & specular highlights
      ctx.fillStyle = '#3a2d28';
      ctx.fillRect(eL.x, eL.y - Math.max(1, Math.round(1.4 * s)), ew, Math.max(1, Math.round(0.9 * s)));
      ctx.fillRect(eR.x, eR.y - Math.max(1, Math.round(1.4 * s)), ew, Math.max(1, Math.round(0.9 * s)));
      ctx.fillStyle = '#22d3ee';
      ctx.fillRect(eL.x + Math.round(1.1 * s), eL.y + Math.round(1.6 * s), Math.max(1, Math.round(1.2 * s)), Math.max(1, Math.round(1.0 * s)));
      ctx.fillRect(eR.x + Math.round(0.7 * s), eR.y + Math.round(1.6 * s), Math.max(1, Math.round(1.2 * s)), Math.max(1, Math.round(1.0 * s)));

      // Soft cheek blush & tiny mouth
      const mPos = pxF(15.4, 11.1);
      ctx.fillStyle = '#d98a6c';
      ctx.fillRect(eL.x - Math.round(1 * s), eL.y + eh + Math.round(0.5 * s), Math.max(1, Math.round(2.4 * s)), Math.max(1, Math.round(1.1 * s)));
      ctx.fillRect(eR.x + ew - Math.round(1.4 * s), eR.y + eh + Math.round(0.5 * s), Math.max(1, Math.round(2.4 * s)), Math.max(1, Math.round(1.1 * s)));
      ctx.fillStyle = '#9a6352';
      ctx.fillRect(mPos.x, mPos.y, Math.max(1, Math.round(2.0 * s)), Math.max(1, Math.round(0.9 * s)));

      // Tunic waist belt & hem trim (front + back)
      for (const fn of [pxF, pxB]) {
        const b0 = fn(13.2, 16.0), b1 = fn(18.8, 17.2);
        ctx.fillStyle = '#5c4b3c';
        ctx.fillRect(Math.min(b0.x, b1.x), b0.y, Math.abs(b1.x - b0.x), Math.max(1, b1.y - b0.y));
        const h0 = fn(12.0, 21.3), h1 = fn(20.0, 22.1);
        ctx.fillStyle = '#849669';
        ctx.fillRect(Math.min(h0.x, h1.x), h0.y, Math.abs(h1.x - h0.x), Math.max(1, h1.y - h0.y));
      }
    },
    pins: [
      { id: 'p_hips', rest: [0, -0.35, 0.10], pos: [0, -0.35, 0.10], anchor: true, keys: {} },
      {
        id: 'p_wave_l',
        rest: [-0.46, -0.18, 0.0],
        pos: [-0.46, -0.18, 0.0],
        anchor: false,
        keys: {
          0: [-0.46, -0.18, 0.0],
          15: [-0.54, 0.18, 0.08],
          30: [-0.46, -0.18, 0.0],
          45: [-0.42, 0.06, -0.06],
        },
      },
      {
        id: 'p_wave_r',
        rest: [0.46, -0.18, 0.0],
        pos: [0.46, -0.18, 0.0],
        anchor: false,
        keys: {
          0: [0.46, -0.18, 0.0],
          15: [0.42, 0.06, -0.06],
          30: [0.46, -0.18, 0.0],
          45: [0.54, 0.18, 0.08],
        },
      },
    ],
  },

  axolotl: {
    name: 'AXOLOTL SLIME',
    gridRes: 24,
    meshMode: 'full',
    lowPolyDetail: 7,
    depth: 0.34,
    roundness: 0.60,
    shadingMode: 'faceted',
    strokes: [
      {
        id: 'ax_body',
        name: 'BODY',
        type: 'closed',
        flapSide: 'sym',
        color: '#f9a8d4',
        visible: true,
        partDepth: 1.0,
        partPuff: 1.0,
        points: [
          { gx: 8, gy: 7 }, { gx: 16, gy: 7 },
          { gx: 18, gy: 12 }, { gx: 17, gy: 18 },
          { gx: 12, gy: 20 }, { gx: 7, gy: 18 }, { gx: 6, gy: 12 },
        ],
      },
      {
        id: 'ax_gill_l',
        name: 'GILL L',
        type: 'flap',
        flapSide: 'sym',
        flapAttach: 0,
        color: '#ec4899',
        visible: true,
        partDepth: 0.85,
        partPuff: 1.0,
        points: [
          { gx: 8, gy: 8 }, { gx: 3, gy: 6 }, { gx: 2, gy: 9 }, { gx: 4, gy: 11 }, { gx: 7, gy: 11 },
        ],
      },
      {
        id: 'ax_gill_r',
        name: 'GILL R',
        type: 'flap',
        flapSide: 'sym',
        flapAttach: 0,
        color: '#ec4899',
        visible: true,
        partDepth: 0.85,
        partPuff: 1.0,
        points: [
          { gx: 16, gy: 8 }, { gx: 21, gy: 6 }, { gx: 22, gy: 9 }, { gx: 20, gy: 11 }, { gx: 17, gy: 11 },
        ],
      },
      {
        id: 'ax_belly',
        name: 'BELLY',
        type: 'extrude',
        flapSide: 'front',
        color: '#fce7f3',
        visible: true,
        partDepth: 0.65,
        partPuff: 1.0,
        points: [
          { gx: 9, gy: 14 }, { gx: 15, gy: 14 }, { gx: 15, gy: 18 }, { gx: 9, gy: 18 },
        ],
      },
    ],
    paintFn: (uvPainter) => {
      const ctx = uvPainter.texCtx;
      const s = uvPainter.texCanvas.height / 64;
      ctx.fillStyle = '#18181b';
      ctx.fillRect(Math.round(25 * s), Math.round(26 * s), Math.round(3 * s), Math.round(3 * s));
      ctx.fillRect(Math.round(37 * s), Math.round(26 * s), Math.round(3 * s), Math.round(3 * s));
      ctx.fillRect(Math.round(30 * s), Math.round(30 * s), Math.round(5 * s), Math.round(2 * s));
    },
    pins: [
      { id: 'ax_base', rest: [0, -0.5, 0.1], pos: [0, -0.5, 0.1], anchor: true, keys: {} },
      {
        id: 'ax_top',
        rest: [0, 0.35, 0.28],
        pos: [0, 0.35, 0.28],
        anchor: false,
        keys: {
          0: [0, 0.35, 0.28],
          15: [0.12, 0.25, 0.28],
          30: [0, 0.42, 0.28],
          45: [-0.12, 0.25, 0.28],
        },
      },
    ],
  },

  dog: {
    name: 'FLAPPY DOG (0% EARS)',
    defaultActiveId: 'dog_ear_l',
    gridRes: 24,
    meshMode: 'full',
    lowPolyDetail: 8,
    depth: 0.35,
    roundness: 0.62,
    shadingMode: 'clay',
    strokes: [
      {
        id: 'dog_head',
        name: 'HEAD',
        type: 'closed',
        flapSide: 'sym',
        color: '#f5f5f4',
        visible: true,
        partDepth: 1.0,
        partPuff: 1.0,
        points: [
          { gx: 8, gy: 5 }, { gx: 11, gy: 3 }, { gx: 13, gy: 3 }, { gx: 16, gy: 5 },
          { gx: 17, gy: 9 }, { gx: 17, gy: 15 }, { gx: 15, gy: 18 },
          { gx: 9, gy: 18 }, { gx: 7, gy: 15 }, { gx: 7, gy: 9 },
        ],
      },
      {
        id: 'dog_ear_l',
        name: 'FLOP EAR L',
        type: 'flap',
        flapSide: 'front',
        flapAttach: 0,
        color: '#78350f',
        visible: true,
        partDepth: 0.72,
        partPuff: 0.95,
        points: [
          { gx: 8, gy: 6 }, { gx: 6, gy: 7 }, { gx: 4, gy: 12 },
          { gx: 4, gy: 18 }, { gx: 6, gy: 20 }, { gx: 8, gy: 18 },
          { gx: 8, gy: 12 }, { gx: 9, gy: 8 },
        ],
      },
      {
        id: 'dog_ear_r',
        name: 'FLOP EAR R',
        type: 'flap',
        flapSide: 'front',
        flapAttach: 0,
        color: '#78350f',
        visible: true,
        partDepth: 0.72,
        partPuff: 0.95,
        points: [
          { gx: 16, gy: 6 }, { gx: 18, gy: 7 }, { gx: 20, gy: 12 },
          { gx: 20, gy: 18 }, { gx: 18, gy: 20 }, { gx: 16, gy: 18 },
          { gx: 16, gy: 12 }, { gx: 15, gy: 8 },
        ],
      },
      {
        id: 'dog_snout',
        name: 'MUZZLE',
        type: 'extrude',
        flapSide: 'front',
        color: '#e7e5e4',
        visible: true,
        partDepth: 0.95,
        partPuff: 0.9,
        points: [
          { gx: 10, gy: 11 }, { gx: 14, gy: 11 }, { gx: 15, gy: 15 },
          { gx: 13, gy: 17 }, { gx: 11, gy: 17 }, { gx: 9, gy: 15 },
        ],
      },
    ],
    paintFn: (uvPainter) => {
      const ctx = uvPainter.texCtx;
      const s = uvPainter.texCanvas.height / 64;
      // Warm brown eye patches
      ctx.fillStyle = '#92400e';
      ctx.fillRect(Math.round(23 * s), Math.round(17 * s), Math.round(7 * s), Math.round(10 * s));
      ctx.fillRect(Math.round(35 * s), Math.round(17 * s), Math.round(7 * s), Math.round(10 * s));
      // Eyes
      ctx.fillStyle = '#141414';
      ctx.fillRect(Math.round(26 * s), Math.round(22 * s), Math.round(3 * s), Math.round(3 * s));
      ctx.fillRect(Math.round(36 * s), Math.round(22 * s), Math.round(3 * s), Math.round(3 * s));
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(Math.round(26 * s), Math.round(22 * s), Math.round(1 * s), Math.round(1 * s));
      ctx.fillRect(Math.round(36 * s), Math.round(22 * s), Math.round(1 * s), Math.round(1 * s));
      // Big dog nose
      ctx.fillStyle = '#1c1917';
      ctx.fillRect(Math.round(29 * s), Math.round(32 * s), Math.round(7 * s), Math.round(4 * s));
    },
    pins: [
      { id: 'dog_chin', rest: [0, -0.38, 0.14], pos: [0, -0.38, 0.14], anchor: true, keys: {} },
      {
        id: 'dog_ear_l_tip',
        rest: [-0.50, -0.58, 0.08],
        pos: [-0.50, -0.58, 0.08],
        anchor: false,
        keys: {
          0: [-0.50, -0.58, 0.08],
          15: [-0.82, 0.25, 0.25],
          30: [-0.50, -0.58, 0.08],
          45: [-0.72, 0.05, 0.18],
        },
      },
      {
        id: 'dog_ear_r_tip',
        rest: [0.50, -0.58, 0.08],
        pos: [0.50, -0.58, 0.08],
        anchor: false,
        keys: {
          0: [0.50, -0.58, 0.08],
          15: [0.82, 0.25, 0.25],
          30: [0.50, -0.58, 0.08],
          45: [0.72, 0.05, 0.18],
        },
      },
    ],
  },
};
