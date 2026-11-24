// Pure WebGL2 3D Viewport Renderer with dFdx/dFdy Flat Normals, Pixel UV Texture & Ray Picker

const VS_MESH = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPos;
layout(location = 1) in vec2 aUv;
layout(location = 2) in vec3 aNorm;

uniform mat4 uProj;
uniform mat4 uView;

out vec3 vWorldPos;
out vec2 vUv;
out vec3 vSmoothNorm;

void main() {
  vWorldPos = aPos;
  vUv = aUv;
  vSmoothNorm = aNorm;
  gl_Position = uProj * uView * vec4(aPos, 1.0);
}
`;

const FS_MESH = `#version 300 es
precision highp float;

in vec3 vWorldPos;
in vec2 vUv;
in vec3 vSmoothNorm;

uniform sampler2D uTex;
uniform int uShadeMode; // 0 = faceted, 1 = glossy clay, 2 = unlit pixel
uniform int uAlphaCutout; // 1 = see-through alpha cutout, 0 = opaque
uniform vec3 uCamPos;

out vec4 fragColor;

void main() {
  vec4 texSample = texture(uTex, vUv);
  if (uAlphaCutout == 1 && texSample.a < 0.35) discard;
  vec3 texCol = texSample.rgb;

  // Screen-space derivatives compute exact flat triangle face normals on the fly!
  vec3 flatN = normalize(cross(dFdx(vWorldPos), dFdy(vWorldPos)));
  if (!gl_FrontFacing) flatN = -flatN;

  vec3 smoothN = length(vSmoothNorm) > 0.001 ? normalize(vSmoothNorm) : flatN;
  vec3 N = (uShadeMode == 1) ? normalize(mix(flatN, smoothN, 0.85)) : flatN;

  if (uShadeMode == 2) {
    // Crisp low-contrast pixel-art mode
    float l = 0.82 + 0.18 * max(dot(N, normalize(vec3(0.4, 0.8, 0.6))), 0.0);
    fragColor = vec4(texCol * l, 1.0);
    return;
  }

  vec3 V = normalize(uCamPos - vWorldPos);
  vec3 L1 = normalize(vec3(0.55, 0.78, 0.65)); // Key light
  vec3 L2 = normalize(vec3(-0.7, -0.3, 0.5)); // Cool fill light
  vec3 L3 = normalize(vec3(0.0, 0.4, -0.9));  // Rim light

  float diff1 = max(dot(N, L1), 0.0);
  float diff2 = max(dot(N, L2), 0.0);
  float rim = pow(1.0 - max(dot(N, V), 0.0), 2.5) * max(dot(N, L3) * 0.5 + 0.5, 0.0);

  if (uShadeMode == 1) {
    // Glossy Monster Mash clay look
    vec3 H = normalize(L1 + V);
    float spec = pow(max(dot(N, H), 0.0), 42.0);
    vec3 baseCol = mix(texCol, vec3(0.86, 0.42, 0.06), 0.15);
    vec3 col = baseCol * (0.28 + diff1 * 0.85 + diff2 * 0.25)
             + vec3(1.0, 0.92, 0.78) * spec * 0.65
             + vec3(0.95, 0.65, 0.35) * rim * 0.3;
    fragColor = vec4(col, 1.0);
    return;
  }

  // Faceted Blockbench low-poly studio shading
  vec3 H = normalize(L1 + V);
  float spec = pow(max(dot(N, H), 0.0), 16.0) * 0.10;
  vec3 col = texCol * (0.42 + diff1 * 0.58 + diff2 * 0.16)
           + vec3(0.22, 0.83, 0.93) * rim * 0.14
           + vec3(1.0) * spec;

  fragColor = vec4(col, 1.0);
}
`;

const VS_LINE = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
uniform mat4 uProj;
uniform mat4 uView;
void main() {
  gl_Position = uProj * uView * vec4(aPos, 1.0);
}
`;

const FS_LINE = `#version 300 es
precision highp float;
uniform vec4 uColor;
out vec4 fragColor;
void main() {
  fragColor = uColor;
}
`;

function compileShader(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(sh));
  }
  return sh;
}

function linkProgram(gl, vsSrc, fsSrc) {
  const prog = gl.createProgram();
  gl.attachShader(prog, compileShader(gl, gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(prog, compileShader(gl, gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(prog));
  }
  return prog;
}

// Minimal 4x4 matrix math (column-major Float32Array)
function mat4Perspective(fovRad, aspect, near, far) {
  const f = 1.0 / Math.tan(fovRad * 0.5);
  const nf = 1 / (near - far);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) * nf;
  m[11] = -1;
  m[14] = 2 * far * near * nf;
  return m;
}

function mat4LookAt(eye, target, up) {
  let zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
  let len = Math.hypot(zx, zy, zz) || 1;
  zx /= len; zy /= len; zz /= len;

  let xx = up[1] * zz - up[2] * zy;
  let xy = up[2] * zx - up[0] * zz;
  let xz = up[0] * zy - up[1] * zx;
  len = Math.hypot(xx, xy, xz) || 1;
  xx /= len; xy /= len; xz /= len;

  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;

  const m = new Float32Array(16);
  m[0] = xx; m[1] = yx; m[2] = zx; m[3] = 0;
  m[4] = xy; m[5] = yy; m[6] = zy; m[7] = 0;
  m[8] = xz; m[9] = yz; m[10] = zz; m[11] = 0;
  m[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
  m[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
  m[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
  m[15] = 1;
  return m;
}

function mat4Mul(a, b) {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[0 * 4 + r] * b[c * 4 + 0] +
        a[1 * 4 + r] * b[c * 4 + 1] +
        a[2 * 4 + r] * b[c * 4 + 2] +
        a[3 * 4 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

function mat4Invert(m) {
  const inv = new Float32Array(16);
  inv[0] = m[5]*m[10]*m[15] - m[5]*m[11]*m[14] - m[9]*m[6]*m[15] + m[9]*m[7]*m[14] + m[13]*m[6]*m[11] - m[13]*m[7]*m[10];
  inv[4] = -m[4]*m[10]*m[15] + m[4]*m[11]*m[14] + m[8]*m[6]*m[15] - m[8]*m[7]*m[14] - m[12]*m[6]*m[11] + m[12]*m[7]*m[10];
  inv[8] = m[4]*m[9]*m[15] - m[4]*m[11]*m[13] - m[8]*m[5]*m[15] + m[8]*m[7]*m[13] + m[12]*m[5]*m[11] - m[12]*m[7]*m[9];
  inv[12] = -m[4]*m[9]*m[14] + m[4]*m[10]*m[13] + m[8]*m[5]*m[14] - m[8]*m[6]*m[13] - m[12]*m[5]*m[10] + m[12]*m[6]*m[9];
  inv[1] = -m[1]*m[10]*m[15] + m[1]*m[11]*m[14] + m[9]*m[2]*m[15] - m[9]*m[3]*m[14] - m[13]*m[2]*m[11] + m[13]*m[3]*m[10];
  inv[5] = m[0]*m[10]*m[15] - m[0]*m[11]*m[14] - m[8]*m[2]*m[15] + m[8]*m[3]*m[14] + m[12]*m[2]*m[11] - m[12]*m[3]*m[10];
  inv[9] = -m[0]*m[9]*m[15] + m[0]*m[11]*m[13] + m[8]*m[1]*m[15] - m[8]*m[3]*m[13] - m[12]*m[1]*m[11] + m[12]*m[3]*m[9];
  inv[13] = m[0]*m[9]*m[14] - m[0]*m[10]*m[13] - m[8]*m[1]*m[14] + m[8]*m[2]*m[13] + m[12]*m[1]*m[10] - m[12]*m[2]*m[9];
  inv[2] = m[1]*m[6]*m[15] - m[1]*m[7]*m[14] - m[5]*m[2]*m[15] + m[5]*m[3]*m[14] + m[13]*m[2]*m[7] - m[13]*m[3]*m[6];
  inv[6] = -m[0]*m[6]*m[15] + m[0]*m[7]*m[14] + m[4]*m[2]*m[15] - m[4]*m[3]*m[14] - m[12]*m[2]*m[7] + m[12]*m[3]*m[6];
  inv[10] = m[0]*m[5]*m[15] - m[0]*m[7]*m[13] - m[4]*m[1]*m[15] + m[4]*m[3]*m[13] + m[12]*m[1]*m[7] - m[12]*m[3]*m[5];
  inv[14] = -m[0]*m[5]*m[14] + m[0]*m[6]*m[13] + m[4]*m[1]*m[14] - m[4]*m[2]*m[13] - m[12]*m[1]*m[6] + m[12]*m[2]*m[5];
  inv[3] = -m[1]*m[6]*m[11] + m[1]*m[7]*m[10] + m[5]*m[2]*m[11] - m[5]*m[3]*m[10] - m[9]*m[2]*m[7] + m[9]*m[3]*m[6];
  inv[7] = m[0]*m[6]*m[11] - m[0]*m[7]*m[10] - m[4]*m[2]*m[11] + m[4]*m[3]*m[10] + m[8]*m[2]*m[7] - m[8]*m[3]*m[6];
  inv[11] = -m[0]*m[5]*m[11] + m[0]*m[7]*m[9] + m[4]*m[1]*m[11] - m[4]*m[3]*m[9] - m[8]*m[1]*m[7] + m[8]*m[3]*m[5];
  inv[15] = m[0]*m[5]*m[10] - m[0]*m[6]*m[9] - m[4]*m[1]*m[10] + m[4]*m[2]*m[9] + m[8]*m[1]*m[6] - m[8]*m[2]*m[5];
  let det = m[0]*inv[0] + m[1]*inv[4] + m[2]*inv[8] + m[3]*inv[12];
  if (Math.abs(det) < 1e-12) return null;
  det = 1.0 / det;
  for (let i = 0; i < 16; i++) inv[i] *= det;
  return inv;
}

export class GlRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl2', { antialias: true, alpha: false });
    if (!this.gl) throw new Error('WebGL2 unavailable');

    this.mesh = null;
    this.renNorm = null;
    this.wireIndices = null;
    this.projMat = new Float32Array(16);
    this.viewMat = new Float32Array(16);
    this.camPos = [0, 0, 3];

    this.initGL();

    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.initGL();
      if (this.mesh) this.uploadMesh(this.mesh);
    });
  }

  initGL() {
    const gl = this.gl;
    this.progMesh = linkProgram(gl, VS_MESH, FS_MESH);
    this.progLine = linkProgram(gl, VS_LINE, FS_LINE);

    // Mesh VAO & Buffers
    this.vaoMesh = gl.createVertexArray();
    gl.bindVertexArray(this.vaoMesh);

    this.vboPos = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vboPos);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

    this.vboUv = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vboUv);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);

    this.vboNorm = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vboNorm);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 0, 0);

    this.iboMesh = gl.createBuffer();
    this.iboWire = gl.createBuffer();

    // Floor Grid VAO
    this.vaoGrid = gl.createVertexArray();
    gl.bindVertexArray(this.vaoGrid);
    this.vboGrid = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vboGrid);
    const gridLines = [];
    const extent = 1.6, steps = 16, yFloor = -1.06;
    for (let i = 0; i <= steps; i++) {
      const t = -extent + (i / steps) * extent * 2;
      gridLines.push(t, yFloor, -extent, t, yFloor, extent);
      gridLines.push(-extent, yFloor, t, extent, yFloor, t);
    }
    this.gridVertCount = gridLines.length / 3;
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(gridLines), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

    // Wireframe VAO (reuses vboPos!)
    this.vaoWire = gl.createVertexArray();
    gl.bindVertexArray(this.vaoWire);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vboPos);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.iboWire);

    gl.bindVertexArray(null);

    // Nearest-neighbor Pixel Art UV Texture
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
  }

  uploadTexture(canvasEl) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvasEl);
  }

  computeSmoothNormals(pos, indices, vertCount) {
    if (!this.renNorm || this.renNorm.length !== vertCount * 3) {
      this.renNorm = new Float32Array(vertCount * 3);
    } else {
      this.renNorm.fill(0);
    }
    const n = this.renNorm;
    for (let i = 0; i < indices.length; i += 3) {
      const ia = indices[i] * 3;
      const ib = indices[i + 1] * 3;
      const ic = indices[i + 2] * 3;
      const ax = pos[ia], ay = pos[ia + 1], az = pos[ia + 2];
      const ux = pos[ib] - ax, uy = pos[ib + 1] - ay, uz = pos[ib + 2] - az;
      const vx = pos[ic] - ax, vy = pos[ic + 1] - ay, vz = pos[ic + 2] - az;
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      n[ia] += nx; n[ia + 1] += ny; n[ia + 2] += nz;
      n[ib] += nx; n[ib + 1] += ny; n[ib + 2] += nz;
      n[ic] += nx; n[ic + 1] += ny; n[ic + 2] += nz;
    }
    for (let i = 0; i < n.length; i += 3) {
      const len = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
      n[i] /= len; n[i + 1] /= len; n[i + 2] /= len;
    }
    return this.renNorm;
  }

  uploadMesh(mesh) {
    this.mesh = mesh;
    if (!mesh) return;
    const gl = this.gl;

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vboPos);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.renPos, gl.DYNAMIC_DRAW);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vboUv);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.renUv, gl.STATIC_DRAW);

    const norms = this.computeSmoothNormals(mesh.renPos, mesh.renIndices, mesh.renVertCount);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vboNorm);
    gl.bufferData(gl.ARRAY_BUFFER, norms, gl.DYNAMIC_DRAW);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.iboMesh);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.renIndices, gl.STATIC_DRAW);

    // Unique wireframe edges
    const edgeSet = new Set();
    const wire = [];
    const addEdge = (u, v) => {
      const key = u < v ? `${u}_${v}` : `${v}_${u}`;
      if (!edgeSet.has(key)) {
        edgeSet.add(key);
        wire.push(u, v);
      }
    };
    const idx = mesh.renIndices;
    for (let i = 0; i < idx.length; i += 3) {
      addEdge(idx[i], idx[i + 1]);
      addEdge(idx[i + 1], idx[i + 2]);
      addEdge(idx[i + 2], idx[i]);
    }
    this.wireIndices = new Uint32Array(wire);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.iboWire);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.wireIndices, gl.STATIC_DRAW);
  }

  /**
   * Zero-GC update of render positions directly from WASM simPositions Float32Array view!
   */
  updateDeformedPositions(simPos) {
    if (!this.mesh || !simPos) return;
    const { renVertCount, renPos, renToSim, renIndices } = this.mesh;
    for (let r = 0; r < renVertCount; r++) {
      const s = renToSim[r] * 3;
      const r3 = r * 3;
      renPos[r3] = simPos[s];
      renPos[r3 + 1] = simPos[s + 1];
      renPos[r3 + 2] = simPos[s + 2];
    }

    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vboPos);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, renPos);

    const norms = this.computeSmoothNormals(renPos, renIndices, renVertCount);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vboNorm);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, norms);
  }

  resizeIfNeeded() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.gl.viewport(0, 0, w, h);
    }
  }

  render(state) {
    this.resizeIfNeeded();
    const gl = this.gl;
    const aspect = this.canvas.width / Math.max(1, this.canvas.height);

    const cp = Math.cos(state.camPitch);
    const sp = Math.sin(state.camPitch);
    const sy = Math.sin(state.camYaw);
    const cy = Math.cos(state.camYaw);

    this.camPos = [
      state.camTarget[0] + state.camDist * cp * sy,
      state.camTarget[1] + state.camDist * sp,
      state.camTarget[2] + state.camDist * cp * cy,
    ];

    this.projMat = mat4Perspective((42 * Math.PI) / 180, aspect, 0.05, 50);
    this.viewMat = mat4LookAt(this.camPos, state.camTarget, [0, 1, 0]);

    gl.clearColor(0.085, 0.085, 0.095, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // 1. Draw Brutalist Floor Grid
    gl.useProgram(this.progLine);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.progLine, 'uProj'), false, this.projMat);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.progLine, 'uView'), false, this.viewMat);
    gl.uniform4f(gl.getUniformLocation(this.progLine, 'uColor'), 0.22, 0.22, 0.25, 1.0);
    gl.bindVertexArray(this.vaoGrid);
    gl.drawArrays(gl.LINES, 0, this.gridVertCount);

    if (!this.mesh) {
      gl.bindVertexArray(null);
      return;
    }

    // 2. Draw Inflated Mesh
    const shadeId = state.shadingMode === 'clay' ? 1 : state.shadingMode === 'unlit' ? 2 : 0;
    gl.useProgram(this.progMesh);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.progMesh, 'uProj'), false, this.projMat);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.progMesh, 'uView'), false, this.viewMat);
    gl.uniform3fv(gl.getUniformLocation(this.progMesh, 'uCamPos'), this.camPos);
    gl.uniform1i(gl.getUniformLocation(this.progMesh, 'uShadeMode'), shadeId);
    gl.uniform1i(gl.getUniformLocation(this.progMesh, 'uAlphaCutout'), state.alphaCutout ? 1 : 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(gl.getUniformLocation(this.progMesh, 'uTex'), 0);

    gl.bindVertexArray(this.vaoMesh);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.iboMesh);
    gl.drawElements(gl.TRIANGLES, this.mesh.renIndices.length, gl.UNSIGNED_INT, 0);

    // 3. Optional Wireframe Overlay
    if (state.wireframe && this.wireIndices) {
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(1.0, 1.0);
      gl.useProgram(this.progLine);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.progLine, 'uProj'), false, this.projMat);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.progLine, 'uView'), false, this.viewMat);
      gl.uniform4f(gl.getUniformLocation(this.progLine, 'uColor'), 0.0, 0.0, 0.0, 0.85);
      gl.bindVertexArray(this.vaoWire);
      gl.drawElements(gl.LINES, this.wireIndices.length, gl.UNSIGNED_INT, 0);
      gl.disable(gl.POLYGON_OFFSET_FILL);
    }

    gl.bindVertexArray(null);
  }

  getScreenRay(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = 1 - ((clientY - rect.top) / rect.height) * 2;
    const invVP = mat4Invert(mat4Mul(this.projMat, this.viewMat));
    if (!invVP) return null;

    const unproj = (x, y, z) => {
      const w = invVP[3] * x + invVP[7] * y + invVP[11] * z + invVP[15];
      return [
        (invVP[0] * x + invVP[4] * y + invVP[8] * z + invVP[12]) / w,
        (invVP[1] * x + invVP[5] * y + invVP[9] * z + invVP[13]) / w,
        (invVP[2] * x + invVP[6] * y + invVP[10] * z + invVP[14]) / w,
      ];
    };

    const p0 = unproj(ndcX, ndcY, -1);
    const p1 = unproj(ndcX, ndcY, 1);
    const dx = p1[0] - p0[0], dy = p1[1] - p0[1], dz = p1[2] - p0[2];
    const len = Math.hypot(dx, dy, dz) || 1;
    return { origin: p0, dir: [dx / len, dy / len, dz / len] };
  }

  pickMesh(clientX, clientY) {
    if (!this.mesh) return null;
    const ray = this.getScreenRay(clientX, clientY);
    if (!ray) return null;

    const { renPos, renUv, renIndices, renToSim } = this.mesh;
    const ox = ray.origin[0], oy = ray.origin[1], oz = ray.origin[2];
    const dx = ray.dir[0], dy = ray.dir[1], dz = ray.dir[2];

    let bestT = Infinity;
    let bestHit = null;
    let bestTriStart = -1;

    for (let i = 0; i < renIndices.length; i += 3) {
      const i0 = renIndices[i];
      const i1 = renIndices[i + 1];
      const i2 = renIndices[i + 2];

      const ax = renPos[i0 * 3], ay = renPos[i0 * 3 + 1], az = renPos[i0 * 3 + 2];
      const e1x = renPos[i1 * 3] - ax, e1y = renPos[i1 * 3 + 1] - ay, e1z = renPos[i1 * 3 + 2] - az;
      const e2x = renPos[i2 * 3] - ax, e2y = renPos[i2 * 3 + 1] - ay, e2z = renPos[i2 * 3 + 2] - az;

      // pvec = cross(dir, e2)
      const px = dy * e2z - dz * e2y;
      const py = dz * e2x - dx * e2z;
      const pz = dx * e2y - dy * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (det < 1e-7) continue; // backface cull

      const invDet = 1 / det;
      const tx = ox - ax, ty = oy - ay, tz = oz - az;
      const u = (tx * px + ty * py + tz * pz) * invDet;
      if (u < 0 || u > 1) continue;

      const qx = ty * e1z - tz * e1y;
      const qy = tz * e1x - tx * e1z;
      const qz = tx * e1y - ty * e1x;
      const v = (dx * qx + dy * qy + dz * qz) * invDet;
      if (v < 0 || u + v > 1) continue;

      const t = (e2x * qx + e2y * qy + e2z * qz) * invDet;
      if (t > 0.01 && t < bestT) {
        bestT = t;
        bestTriStart = i;
        const w = 1 - u - v;
        const hitPt = [ox + dx * t, oy + dy * t, oz + dz * t];
        const hitUv = [
          w * renUv[i0 * 2] + u * renUv[i1 * 2] + v * renUv[i2 * 2],
          w * renUv[i0 * 2 + 1] + u * renUv[i1 * 2 + 1] + v * renUv[i2 * 2 + 1],
        ];
        // Pick closest corner vertex of hit triangle for pin placement
        const closestRen = (w >= u && w >= v) ? i0 : (u >= v ? i1 : i2);
        bestHit = {
          t,
          point: hitPt,
          uv: hitUv,
          renIdx: closestRen,
          simIdx: renToSim[closestRen],
          strokeId: null,
        };
      }
    }

    if (bestHit && this.mesh.regionMeta) {
      for (const reg of this.mesh.regionMeta) {
        if (bestTriStart >= reg.triStart && bestTriStart < reg.triStart + reg.triCount * 3) {
          bestHit.strokeId = reg.strokeId;
          break;
        }
      }
      if (!bestHit.strokeId && this.mesh.simRegionId) {
        const regIdx = this.mesh.simRegionId[bestHit.simIdx];
        if (regIdx >= 0 && this.mesh.regionMeta[regIdx]) {
          bestHit.strokeId = this.mesh.regionMeta[regIdx].strokeId;
        }
      }
    }

    return bestHit;
  }

  projectToScreen(pt) {
    const vp = mat4Mul(this.projMat, this.viewMat);
    const x = pt[0], y = pt[1], z = pt[2];
    const cx = vp[0] * x + vp[4] * y + vp[8] * z + vp[12];
    const cy = vp[1] * x + vp[5] * y + vp[9] * z + vp[13];
    const cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
    if (cw <= 0.001) return null;
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: ((cx / cw) * 0.5 + 0.5) * rect.width,
      y: (1 - ((cy / cw) * 0.5 + 0.5)) * rect.height,
    };
  }

  /**
   * Intersect screen ray with camera-facing plane passing through `anchorPt`
   */
  intersectViewPlane(clientX, clientY, anchorPt) {
    const ray = this.getScreenRay(clientX, clientY);
    if (!ray) return null;
    const nx = this.camPos[0] - anchorPt[0];
    const ny = this.camPos[1] - anchorPt[1];
    const nz = this.camPos[2] - anchorPt[2];
    const denom = ray.dir[0] * nx + ray.dir[1] * ny + ray.dir[2] * nz;
    if (Math.abs(denom) < 1e-6) return null;
    const t = ((anchorPt[0] - ray.origin[0]) * nx + (anchorPt[1] - ray.origin[1]) * ny + (anchorPt[2] - ray.origin[2]) * nz) / denom;
    return [
      ray.origin[0] + ray.dir[0] * t,
      ray.origin[1] + ray.dir[1] * t,
      ray.origin[2] + ray.dir[2] * t,
    ];
  }
}
