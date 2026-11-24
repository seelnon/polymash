#![no_std]

/// MashGrid WASM Solver Kernel
///
/// Operates directly on shared linear-memory slices passed by JS (`wasm-bridge.js`):
/// - `poisson_relax`: Gauss-Seidel SOR weighted-Laplacian inflation for 2.5D heightfields.
/// - `arap_step`: Local-Global As-Rigid-As-Possible 2.5D pin deformation solver.
/// - `softbody_verlet`: Secondary spring-Verlet jiggle dynamics around the ARAP pose.

#[no_mangle]
pub unsafe extern "C" fn poisson_relax(
    vert_count: i32,
    adj_off_ptr: *const i32,
    adj_idx_ptr: *const i32,
    adj_w_ptr: *const f32,
    z_ptr: *mut f32,
    flags_ptr: *const i32,
    source_c: f32,
    omega: f32,
    iters: i32,
) {
    let n = vert_count as usize;
    for _ in 0..iters {
        for i in 0..n {
            if *flags_ptr.add(i) != 0 {
                continue;
            }
            let start = *adj_off_ptr.add(i) as usize;
            let end = *adj_off_ptr.add(i + 1) as usize;
            let mut sum_wz: f32 = 0.0;
            let mut sum_w: f32 = 0.0;
            for k in start..end {
                let nbr = *adj_idx_ptr.add(k) as usize;
                let w = *adj_w_ptr.add(k);
                sum_wz += w * *z_ptr.add(nbr);
                sum_w += w;
            }
            if sum_w > 1e-6 {
                let target = (sum_wz + source_c) / sum_w;
                let cur = *z_ptr.add(i);
                *z_ptr.add(i) = cur + omega * (target - cur);
            }
        }
    }
}

#[inline(always)]
fn fast_sqrt(x: f32) -> f32 {
    if x <= 0.0 {
        return 0.0;
    }
    let mut g = x;
    let mut i = 0;
    while i < 6 {
        g = 0.5 * (g + x / g);
        i += 1;
    }
    g
}

#[inline(always)]
fn abs_f32(x: f32) -> f32 {
    if x < 0.0 { -x } else { x }
}

#[inline(always)]
fn rotate_vec_quat(qx: f32, qy: f32, qz: f32, qw: f32, vx: f32, vy: f32, vz: f32) -> (f32, f32, f32) {
    let tx = 2.0 * (qy * vz - qz * vy);
    let ty = 2.0 * (qz * vx - qx * vz);
    let tz = 2.0 * (qx * vy - qy * vx);
    (
        vx + qw * tx + (qy * tz - qz * ty),
        vy + qw * ty + (qz * tx - qx * tz),
        vz + qw * tz + (qx * ty - qy * tx),
    )
}

#[no_mangle]
pub unsafe extern "C" fn arap_step(
    vert_count: i32,
    adj_off_ptr: *const i32,
    adj_idx_ptr: *const i32,
    adj_w_ptr: *const f32,
    pos_ptr: *mut f32,
    rest_ptr: *const f32,
    pin_flag_ptr: *const i32,
    pin_target_ptr: *const f32,
    rot_ptr: *mut f32,
    iters: i32,
    rigidity: f32,
) {
    let n = vert_count as usize;

    for _ in 0..iters {
        // 1. Local step: extract optimal 3D SO(3) rotation quaternion per vertex (warm-started)
        for i in 0..n {
            let start = *adj_off_ptr.add(i) as usize;
            let end = *adj_off_ptr.add(i + 1) as usize;
            let px = *pos_ptr.add(i * 3);
            let py = *pos_ptr.add(i * 3 + 1);
            let pz = *pos_ptr.add(i * 3 + 2);
            let rx = *rest_ptr.add(i * 3);
            let ry = *rest_ptr.add(i * 3 + 1);
            let rz = *rest_ptr.add(i * 3 + 2);

            let (mut a00, mut a01, mut a02) = (0.0f32, 0.0f32, 0.0f32);
            let (mut a10, mut a11, mut a12) = (0.0f32, 0.0f32, 0.0f32);
            let (mut a20, mut a21, mut a22) = (0.0f32, 0.0f32, 0.0f32);

            for k in start..end {
                let j = *adj_idx_ptr.add(k) as usize;
                let w = *adj_w_ptr.add(k);
                let dpx = *pos_ptr.add(j * 3) - px;
                let dpy = *pos_ptr.add(j * 3 + 1) - py;
                let dpz = *pos_ptr.add(j * 3 + 2) - pz;
                let drx = *rest_ptr.add(j * 3) - rx;
                let dry = *rest_ptr.add(j * 3 + 1) - ry;
                let drz = *rest_ptr.add(j * 3 + 2) - rz;

                a00 += w * dpx * drx; a01 += w * dpx * dry; a02 += w * dpx * drz;
                a10 += w * dpy * drx; a11 += w * dpy * dry; a12 += w * dpy * drz;
                a20 += w * dpz * drx; a21 += w * dpz * dry; a22 += w * dpz * drz;
            }

            let qb = i * 4;
            let mut qx = *rot_ptr.add(qb);
            let mut qy = *rot_ptr.add(qb + 1);
            let mut qz = *rot_ptr.add(qb + 2);
            let mut qw = *rot_ptr.add(qb + 3);
            let qlen = fast_sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
            if qlen > 1e-6 {
                let invq = 1.0 / qlen;
                qx *= invq; qy *= invq; qz *= invq; qw *= invq;
            } else {
                qx = 0.0; qy = 0.0; qz = 0.0; qw = 1.0;
            }

            let mut rot_it = 0;
            while rot_it < 6 {
                let xx = qx * qx; let yy = qy * qy; let zz = qz * qz;
                let xy = qx * qy; let xz = qx * qz; let yz = qy * qz;
                let wx = qw * qx; let wy = qw * qy; let wz = qw * qz;

                let r00 = 1.0 - 2.0 * (yy + zz); let r10 = 2.0 * (xy + wz);       let r20 = 2.0 * (xz - wy);
                let r01 = 2.0 * (xy - wz);       let r11 = 1.0 - 2.0 * (xx + zz); let r21 = 2.0 * (yz + wx);
                let r02 = 2.0 * (xz + wy);       let r12 = 2.0 * (yz - wx);       let r22 = 1.0 - 2.0 * (xx + yy);

                let num_x = (r10 * a20 - r20 * a10) + (r11 * a21 - r21 * a11) + (r12 * a22 - r22 * a12);
                let num_y = (r20 * a00 - r00 * a20) + (r21 * a01 - r01 * a21) + (r22 * a02 - r02 * a22);
                let num_z = (r00 * a10 - r10 * a00) + (r01 * a11 - r11 * a01) + (r02 * a12 - r12 * a02);
                let denom = abs_f32(
                    r00 * a00 + r10 * a10 + r20 * a20 +
                    r01 * a01 + r11 * a11 + r21 * a21 +
                    r02 * a02 + r12 * a12 + r22 * a22
                ) + 1e-7;

                let mut ox = num_x / denom;
                let mut oy = num_y / denom;
                let mut oz = num_z / denom;
                let w2 = ox * ox + oy * oy + oz * oz;
                if w2 < 1e-10 {
                    break;
                }
                if w2 > 1.0 {
                    let s = 1.0 / fast_sqrt(w2);
                    ox *= s; oy *= s; oz *= s;
                }
                let hx = 0.5 * ox;
                let hy = 0.5 * oy;
                let hz = 0.5 * oz;
                let nqx = hx * qw + qx + hy * qz - hz * qy;
                let nqy = hy * qw + qy + hz * qx - hx * qz;
                let nqz = hz * qw + qz + hx * qy - hy * qx;
                let nqw = qw - hx * qx - hy * qy - hz * qz;
                let nlen = fast_sqrt(nqx * nqx + nqy * nqy + nqz * nqz + nqw * nqw);
                if nlen > 1e-6 {
                    let invn = 1.0 / nlen;
                    qx = nqx * invn; qy = nqy * invn; qz = nqz * invn; qw = nqw * invn;
                }
                rot_it += 1;
            }

            *rot_ptr.add(qb) = qx;
            *rot_ptr.add(qb + 1) = qy;
            *rot_ptr.add(qb + 2) = qz;
            *rot_ptr.add(qb + 3) = qw;
        }

        // 2. Global Gauss-Seidel relaxation step with 3D rotations and pin Dirichlet constraints
        for i in 0..n {
            if *pin_flag_ptr.add(i) != 0 {
                *pos_ptr.add(i * 3) = *pin_target_ptr.add(i * 3);
                *pos_ptr.add(i * 3 + 1) = *pin_target_ptr.add(i * 3 + 1);
                *pos_ptr.add(i * 3 + 2) = *pin_target_ptr.add(i * 3 + 2);
                continue;
            }

            let start = *adj_off_ptr.add(i) as usize;
            let end = *adj_off_ptr.add(i + 1) as usize;
            let qb = i * 4;
            let qix = *rot_ptr.add(qb);
            let qiy = *rot_ptr.add(qb + 1);
            let qiz = *rot_ptr.add(qb + 2);
            let qiw = *rot_ptr.add(qb + 3);
            let rx = *rest_ptr.add(i * 3);
            let ry = *rest_ptr.add(i * 3 + 1);
            let rz = *rest_ptr.add(i * 3 + 2);

            let mut sx: f32 = 0.0;
            let mut sy: f32 = 0.0;
            let mut sz: f32 = 0.0;
            let mut sw: f32 = 0.0;

            for k in start..end {
                let j = *adj_idx_ptr.add(k) as usize;
                let w = *adj_w_ptr.add(k);
                let qjb = j * 4;
                let qjx = *rot_ptr.add(qjb);
                let qjy = *rot_ptr.add(qjb + 1);
                let qjz = *rot_ptr.add(qjb + 2);
                let qjw = *rot_ptr.add(qjb + 3);

                let drx = rx - *rest_ptr.add(j * 3);
                let dry = ry - *rest_ptr.add(j * 3 + 1);
                let drz = rz - *rest_ptr.add(j * 3 + 2);

                let (v1x, v1y, v1z) = rotate_vec_quat(qix, qiy, qiz, qiw, drx, dry, drz);
                let (v2x, v2y, v2z) = rotate_vec_quat(qjx, qjy, qjz, qjw, drx, dry, drz);

                let tx = *pos_ptr.add(j * 3) + 0.5 * (v1x + v2x);
                let ty = *pos_ptr.add(j * 3 + 1) + 0.5 * (v1y + v2y);
                let tz = *pos_ptr.add(j * 3 + 2) + 0.5 * (v1z + v2z);

                sx += w * tx;
                sy += w * ty;
                sz += w * tz;
                sw += w;
            }

            if sw > 1e-6 {
                let inv = 1.0 / sw;
                let gx = sx * inv;
                let gy = sy * inv;
                let gz = sz * inv;
                *pos_ptr.add(i * 3) += rigidity * (gx - *pos_ptr.add(i * 3));
                *pos_ptr.add(i * 3 + 1) += rigidity * (gy - *pos_ptr.add(i * 3 + 1));
                *pos_ptr.add(i * 3 + 2) += rigidity * (gz - *pos_ptr.add(i * 3 + 2));
            }
        }
    }
}

#[no_mangle]
pub unsafe extern "C" fn softbody_verlet(
    vert_count: i32,
    adj_off_ptr: *const i32,
    adj_idx_ptr: *const i32,
    adj_w_ptr: *const f32,
    pos_ptr: *mut f32,
    prev_ptr: *mut f32,
    target_ptr: *const f32,
    pin_flag_ptr: *const i32,
    stiffness: f32,
    damping: f32,
    couple: f32,
) {
    let n = vert_count as usize;
    // Pass 1: Pure damped Verlet spring step (unconditionally stable for any damping < 1)
    for i in 0..n {
        let base = i * 3;
        if *pin_flag_ptr.add(i) != 0 {
            let tx = *target_ptr.add(base);
            let ty = *target_ptr.add(base + 1);
            let tz = *target_ptr.add(base + 2);
            *pos_ptr.add(base) = tx;
            *pos_ptr.add(base + 1) = ty;
            *pos_ptr.add(base + 2) = tz;
            *prev_ptr.add(base) = tx;
            *prev_ptr.add(base + 1) = ty;
            *prev_ptr.add(base + 2) = tz;
            continue;
        }

        let px = *pos_ptr.add(base);
        let py = *pos_ptr.add(base + 1);
        let pz = *pos_ptr.add(base + 2);

        let vx = (px - *prev_ptr.add(base)) * damping;
        let vy = (py - *prev_ptr.add(base + 1)) * damping;
        let vz = (pz - *prev_ptr.add(base + 2)) * damping;

        *prev_ptr.add(base) = px;
        *prev_ptr.add(base + 1) = py;
        *prev_ptr.add(base + 2) = pz;

        let fx = (*target_ptr.add(base) - px) * stiffness;
        let fy = (*target_ptr.add(base + 1) - py) * stiffness;
        let fz = (*target_ptr.add(base + 2) - pz) * stiffness;

        *pos_ptr.add(base) = px + vx + fx;
        *pos_ptr.add(base + 1) = py + vy + fy;
        *pos_ptr.add(base + 2) = pz + vz + fz;
    }

    // Pass 2: Edge-coupled elastic wave & kinetic momentum transfer from moved flaps/parts across the mesh
    if couple > 1e-4 {
        let edge_k = if couple * 1.15 > 0.44 { 0.44 } else { couple * 1.15 };
        let vel_k = couple * 0.65;
        for i in 0..n {
            if *pin_flag_ptr.add(i) != 0 {
                continue;
            }
            let base = i * 3;
            let px = *pos_ptr.add(base);
            let py = *pos_ptr.add(base + 1);
            let pz = *pos_ptr.add(base + 2);
            let vx_self = px - *prev_ptr.add(base);
            let vy_self = py - *prev_ptr.add(base + 1);
            let vz_self = pz - *prev_ptr.add(base + 2);
            let ux_self = px - *target_ptr.add(base);
            let uy_self = py - *target_ptr.add(base + 1);
            let uz_self = pz - *target_ptr.add(base + 2);

            let start = *adj_off_ptr.add(i) as usize;
            let end = *adj_off_ptr.add(i + 1) as usize;
            let mut sx: f32 = 0.0;
            let mut sy: f32 = 0.0;
            let mut sz: f32 = 0.0;
            let mut ux: f32 = 0.0;
            let mut uy: f32 = 0.0;
            let mut uz: f32 = 0.0;
            let mut sw: f32 = 0.0;
            for k in start..end {
                let j = *adj_idx_ptr.add(k) as usize;
                let w = *adj_w_ptr.add(k);
                let jb = j * 3;
                let jpx = *pos_ptr.add(jb);
                let jpy = *pos_ptr.add(jb + 1);
                let jpz = *pos_ptr.add(jb + 2);
                sx += w * (jpx - *prev_ptr.add(jb));
                sy += w * (jpy - *prev_ptr.add(jb + 1));
                sz += w * (jpz - *prev_ptr.add(jb + 2));
                ux += w * (jpx - *target_ptr.add(jb));
                uy += w * (jpy - *target_ptr.add(jb + 1));
                uz += w * (jpz - *target_ptr.add(jb + 2));
                sw += w;
            }
            if sw > 1e-6 {
                let inv = 1.0 / sw;
                let dvx = (sx * inv - vx_self) * vel_k;
                let dvy = (sy * inv - vy_self) * vel_k;
                let dvz = (sz * inv - vz_self) * vel_k;
                let dux = (ux * inv - ux_self) * edge_k;
                let duy = (uy * inv - uy_self) * edge_k;
                let duz = (uz * inv - uz_self) * edge_k;
                *pos_ptr.add(base) = px + dvx + dux;
                *pos_ptr.add(base + 1) = py + dvy + duy;
                *pos_ptr.add(base + 2) = pz + dvz + duz;
            }
        }
    }
}
