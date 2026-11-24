#!/usr/bin/env python3
"""
Builds public/wasm/mesh_solver.wasm matching src/rust/src/lib.rs ABI:
Imports:
  env.memory : memory(64, 512)
Exports:
  poisson_relax(vert_count: i32, adj_off_ptr: i32, adj_idx_ptr: i32, adj_w_ptr: i32,
                z_ptr: i32, flags_ptr: i32, source_c: f32, omega: f32, iters: i32)
  arap_step(vert_count: i32, adj_off_ptr: i32, adj_idx_ptr: i32, adj_w_ptr: i32,
            pos_ptr: i32, rest_ptr: i32, pin_flag_ptr: i32, pin_target_ptr: i32,
            rot_ptr: i32, iters: i32, rigidity: f32)
  softbody_verlet(vert_count: i32, adj_off_ptr: i32, adj_idx_ptr: i32, adj_w_ptr: i32,
                  pos_ptr: i32, prev_ptr: i32, target_ptr: i32,
                  pin_flag_ptr: i32, stiffness: f32, damping: f32, couple: f32)
"""
import os
import struct

I32 = 0x7F
I64 = 0x7E
F32 = 0x7D
F64 = 0x7C
VOID = 0x40


def uleb(v: int) -> bytes:
    out = bytearray()
    while True:
        b = v & 0x7F
        v >>= 7
        if v != 0:
            out.append(b | 0x80)
        else:
            out.append(b)
            break
    return bytes(out)


def sleb(v: int) -> bytes:
    out = bytearray()
    more = True
    while more:
        b = v & 0x7F
        v >>= 7
        if (v == 0 and (b & 0x40) == 0) or (v == -1 and (b & 0x40) != 0):
            more = False
        else:
            b |= 0x80
        out.append(b)
    return bytes(out)


def vec(items: list[bytes]) -> bytes:
    return uleb(len(items)) + b"".join(items)


def name(s: str) -> bytes:
    b = s.encode("utf-8")
    return uleb(len(b)) + b


def section(sec_id: int, payload: bytes) -> bytes:
    return bytes([sec_id]) + uleb(len(payload)) + payload


class Code:
    def __init__(self):
        self.buf = bytearray()

    def op(self, *bs):
        self.buf.extend(bs)
        return self

    def u(self, v: int):
        self.buf.extend(uleb(v))
        return self

    def s(self, v: int):
        self.buf.extend(sleb(v))
        return self

    def f32(self, v: float):
        self.buf.append(0x43)
        self.buf.extend(struct.pack("<f", v))
        return self

    def i32(self, v: int):
        self.buf.append(0x41)
        self.buf.extend(sleb(v))
        return self

    def local_get(self, idx: int):
        return self.op(0x20).u(idx)

    def local_set(self, idx: int):
        return self.op(0x21).u(idx)

    def local_tee(self, idx: int):
        return self.op(0x22).u(idx)

    def i32_load(self, offset=0, align=2):
        return self.op(0x28).u(align).u(offset)

    def f32_load(self, offset=0, align=2):
        return self.op(0x2A).u(align).u(offset)

    def f32_store(self, offset=0, align=2):
        return self.op(0x38).u(align).u(offset)

    def block(self):
        return self.op(0x02, VOID)

    def loop(self):
        return self.op(0x03, VOID)

    def if_(self):
        return self.op(0x04, VOID)

    def else_(self):
        return self.op(0x05)

    def end(self):
        return self.op(0x0B)

    def br(self, depth: int):
        return self.op(0x0C).u(depth)

    def br_if(self, depth: int):
        return self.op(0x0D).u(depth)

    # Integer ops
    def i32_add(self): return self.op(0x6A)
    def i32_sub(self): return self.op(0x6B)
    def i32_mul(self): return self.op(0x6C)
    def i32_shl(self): return self.op(0x74)
    def i32_eq(self): return self.op(0x46)
    def i32_ne(self): return self.op(0x47)
    def i32_lt_s(self): return self.op(0x48)
    def i32_ge_s(self): return self.op(0x4E)

    # Float ops
    def f32_add(self): return self.op(0x92)
    def f32_sub(self): return self.op(0x93)
    def f32_mul(self): return self.op(0x94)
    def f32_div(self): return self.op(0x95)
    def f32_sqrt(self): return self.op(0x91)
    def f32_abs(self): return self.op(0x8B)
    def f32_gt(self): return self.op(0x5E)

    def build(self, locals_spec: list[tuple[int, int]]) -> bytes:
        lbytes = uleb(len(locals_spec))
        for count, typ in locals_spec:
            lbytes += uleb(count) + bytes([typ])
        body = lbytes + bytes(self.buf) + b"\x0B"
        return uleb(len(body)) + body


def build_poisson_relax() -> bytes:
    # Params:
    # 0: vert_count (i32)
    # 1: adj_off_ptr (i32)
    # 2: adj_idx_ptr (i32)
    # 3: adj_w_ptr (i32)
    # 4: z_ptr (i32)
    # 5: flags_ptr (i32)
    # 6: source_c (f32)
    # 7: omega (f32)
    # 8: iters (i32)
    #
    # Locals:
    # 9..13 (5 i32): iter, i, start, end, k
    # 14..17 (4 f32): sum_wz, sum_w, w, cur
    # 18 (1 i32): ptr_tmp
    c = Code()
    iter_l, i_l, start_l, end_l, k_l = 9, 10, 11, 12, 13
    sum_wz, sum_w, w_l, cur_l = 14, 15, 16, 17
    ptr_l = 18

    # if vert_count <= 0 or iters <= 0 return
    c.local_get(0).i32(0).op(0x4C)  # i32.le_s
    c.if_().op(0x0F).end()  # return
    c.local_get(8).i32(0).op(0x4C)
    c.if_().op(0x0F).end()

    c.i32(0).local_set(iter_l)
    c.block().loop()  # outer iter loop (br 0 = continue, br 1 = break)
    c.local_get(iter_l).local_get(8).i32_ge_s().br_if(1)

    c.i32(0).local_set(i_l)
    c.block().loop()  # vertex loop i (br 0 = continue, br 1 = break)
    c.local_get(i_l).local_get(0).i32_ge_s().br_if(1)

    # if flags[i] == 0
    c.local_get(5).local_get(i_l).i32(2).i32_shl().i32_add().i32_load()
    c.i32(0).i32_eq()
    c.if_()

    # start = adj_off[i], end = adj_off[i+1]
    c.local_get(1).local_get(i_l).i32(2).i32_shl().i32_add().local_tee(ptr_l).i32_load().local_set(start_l)
    c.local_get(ptr_l).i32_load(4).local_set(end_l)

    c.f32(0.0).local_set(sum_wz)
    c.f32(0.0).local_set(sum_w)
    c.local_get(start_l).local_set(k_l)

    c.block().loop()  # neighbor loop k
    c.local_get(k_l).local_get(end_l).i32_ge_s().br_if(1)

    # w = adj_w[k]
    c.local_get(3).local_get(k_l).i32(2).i32_shl().i32_add().f32_load().local_set(w_l)
    # nbr = adj_idx[k]
    c.local_get(2).local_get(k_l).i32(2).i32_shl().i32_add().i32_load()
    # z[nbr]
    c.i32(2).i32_shl().local_get(4).i32_add().f32_load()
    c.local_get(w_l).f32_mul().local_get(sum_wz).f32_add().local_set(sum_wz)
    c.local_get(sum_w).local_get(w_l).f32_add().local_set(sum_w)

    c.local_get(k_l).i32(1).i32_add().local_set(k_l)
    c.br(0).end().end()  # end k loop

    # if sum_w > 1e-6
    c.local_get(sum_w).f32(1e-6).f32_gt()
    c.if_()
    # ptr = z_ptr + i*4
    c.local_get(4).local_get(i_l).i32(2).i32_shl().i32_add().local_tee(ptr_l)
    c.f32_load().local_set(cur_l)
    # z[i] = cur + omega * (((sum_wz + source_c) / sum_w) - cur)
    c.local_get(ptr_l)
    c.local_get(cur_l)
    c.local_get(7)  # omega
    c.local_get(sum_wz).local_get(6).f32_add().local_get(sum_w).f32_div()
    c.local_get(cur_l).f32_sub()
    c.f32_mul().f32_add()
    c.f32_store()
    c.end()  # end if sum_w

    c.end()  # end if flag == 0

    c.local_get(i_l).i32(1).i32_add().local_set(i_l)
    c.br(0).end().end()  # end i loop

    c.local_get(iter_l).i32(1).i32_add().local_set(iter_l)
    c.br(0).end().end()  # end iter loop

    return c.build([(5, I32), (4, F32), (1, I32)])


def build_arap_step() -> bytes:
    # Params:
    # 0: vert_count (i32)
    # 1: adj_off_ptr (i32)
    # 2: adj_idx_ptr (i32)
    # 3: adj_w_ptr (i32)
    # 4: pos_ptr (i32)
    # 5: rest_ptr (i32)
    # 6: pin_flag_ptr (i32)
    # 7: pin_target_ptr (i32)
    # 8: rot_ptr (i32)  -- 4 f32 per vertex: [qx, qy, qz, qw]
    # 9: iters (i32)
    # 10: rigidity (f32)
    c = Code()
    iter_l, i_l, start_l, end_l, k_l, j_l, poff_l, joff_l, ptr_l, rit_l = range(11, 21)

    f_px, f_py, f_pz = 21, 22, 23
    f_rx, f_ry, f_rz = 24, 25, 26
    f_a00, f_a01, f_a02, f_a10, f_a11, f_a12, f_a20, f_a21, f_a22 = range(27, 36)
    f_qx, f_qy, f_qz, f_qw = 36, 37, 38, 39
    f_r00, f_r01, f_r02, f_r10, f_r11, f_r12, f_r20, f_r21, f_r22 = range(40, 49)
    f_w, f_dpx, f_dpy, f_dpz, f_drx, f_dry, f_drz, f_t1, f_t2 = range(49, 58)
    f_t3, f_t4, f_t5, f_t6, f_t7, f_t8, f_t9, f_t10, f_t11, f_t12, f_t13 = range(58, 69)

    # Global step aliases (disjoint from local step):
    f_sx, f_sy, f_sz, f_sw = f_r00, f_r01, f_r02, f_r10
    f_qjx, f_qjy, f_qjz, f_qjw, f_inv = f_r11, f_r12, f_r20, f_r21, f_r22

    c.local_get(0).i32(0).op(0x4C).if_().op(0x0F).end()
    c.local_get(9).i32(0).op(0x4C).if_().op(0x0F).end()

    c.i32(0).local_set(iter_l)
    c.block().loop()  # outer iter
    c.local_get(iter_l).local_get(9).i32_ge_s().br_if(1)

    # ===== 1. LOCAL STEP (3D SO(3) Quaternion Polar Extraction) =====
    c.i32(0).local_set(i_l)
    c.block().loop()
    c.local_get(i_l).local_get(0).i32_ge_s().br_if(1)

    c.local_get(1).local_get(i_l).i32(2).i32_shl().i32_add().local_tee(ptr_l).i32_load().local_set(start_l)
    c.local_get(ptr_l).i32_load(4).local_set(end_l)

    c.local_get(i_l).i32(12).i32_mul().local_set(poff_l)
    c.local_get(4).local_get(poff_l).i32_add().local_tee(ptr_l).f32_load(0).local_set(f_px)
    c.local_get(ptr_l).f32_load(4).local_set(f_py)
    c.local_get(ptr_l).f32_load(8).local_set(f_pz)
    c.local_get(5).local_get(poff_l).i32_add().local_tee(ptr_l).f32_load(0).local_set(f_rx)
    c.local_get(ptr_l).f32_load(4).local_set(f_ry)
    c.local_get(ptr_l).f32_load(8).local_set(f_rz)

    for reg in (f_a00, f_a01, f_a02, f_a10, f_a11, f_a12, f_a20, f_a21, f_a22):
        c.f32(0.0).local_set(reg)

    c.local_get(start_l).local_set(k_l)
    c.block().loop()
    c.local_get(k_l).local_get(end_l).i32_ge_s().br_if(1)

    c.local_get(3).local_get(k_l).i32(2).i32_shl().i32_add().f32_load().local_set(f_w)
    c.local_get(2).local_get(k_l).i32(2).i32_shl().i32_add().i32_load().i32(12).i32_mul().local_set(joff_l)

    c.local_get(4).local_get(joff_l).i32_add().local_tee(ptr_l).f32_load(0).local_get(f_px).f32_sub().local_set(f_dpx)
    c.local_get(ptr_l).f32_load(4).local_get(f_py).f32_sub().local_set(f_dpy)
    c.local_get(ptr_l).f32_load(8).local_get(f_pz).f32_sub().local_set(f_dpz)

    c.local_get(5).local_get(joff_l).i32_add().local_tee(ptr_l).f32_load(0).local_get(f_rx).f32_sub().local_set(f_drx)
    c.local_get(ptr_l).f32_load(4).local_get(f_ry).f32_sub().local_set(f_dry)
    c.local_get(ptr_l).f32_load(8).local_get(f_rz).f32_sub().local_set(f_drz)

    for acc, dp, dr in (
        (f_a00, f_dpx, f_drx), (f_a01, f_dpx, f_dry), (f_a02, f_dpx, f_drz),
        (f_a10, f_dpy, f_drx), (f_a11, f_dpy, f_dry), (f_a12, f_dpy, f_drz),
        (f_a20, f_dpz, f_drx), (f_a21, f_dpz, f_dry), (f_a22, f_dpz, f_drz),
    ):
        c.local_get(acc).local_get(f_w).local_get(dp).local_get(dr).f32_mul().f32_mul().f32_add().local_set(acc)

    c.local_get(k_l).i32(1).i32_add().local_set(k_l)
    c.br(0).end().end()  # end k

    # Load & normalize warm-started quaternion q = rot[i*4]
    c.local_get(8).local_get(i_l).i32(4).i32_shl().i32_add().local_tee(ptr_l).f32_load(0).local_set(f_qx)
    c.local_get(ptr_l).f32_load(4).local_set(f_qy)
    c.local_get(ptr_l).f32_load(8).local_set(f_qz)
    c.local_get(ptr_l).f32_load(12).local_set(f_qw)

    c.local_get(f_qx).local_get(f_qx).f32_mul()
    c.local_get(f_qy).local_get(f_qy).f32_mul().f32_add()
    c.local_get(f_qz).local_get(f_qz).f32_mul().f32_add()
    c.local_get(f_qw).local_get(f_qw).f32_mul().f32_add().f32_sqrt().local_set(f_t1)
    c.local_get(f_t1).f32(1e-6).f32_gt()
    c.if_()
    c.f32(1.0).local_get(f_t1).f32_div().local_set(f_t2)
    c.local_get(f_qx).local_get(f_t2).f32_mul().local_set(f_qx)
    c.local_get(f_qy).local_get(f_t2).f32_mul().local_set(f_qy)
    c.local_get(f_qz).local_get(f_t2).f32_mul().local_set(f_qz)
    c.local_get(f_qw).local_get(f_t2).f32_mul().local_set(f_qw)
    c.else_()
    c.f32(0.0).local_set(f_qx).f32(0.0).local_set(f_qy).f32(0.0).local_set(f_qz).f32(1.0).local_set(f_qw)
    c.end()

    # 6 Mueller SO(3) polar extraction iterations
    c.i32(0).local_set(rit_l)
    c.block().loop()
    c.local_get(rit_l).i32(6).i32_ge_s().br_if(1)

    # xx=t1, yy=t2, zz=t3, xy=t4, xz=t5, yz=t6, wx=t7, wy=t8, wz=t9
    c.local_get(f_qx).local_get(f_qx).f32_mul().local_set(f_t1)
    c.local_get(f_qy).local_get(f_qy).f32_mul().local_set(f_t2)
    c.local_get(f_qz).local_get(f_qz).f32_mul().local_set(f_t3)
    c.local_get(f_qx).local_get(f_qy).f32_mul().local_set(f_t4)
    c.local_get(f_qx).local_get(f_qz).f32_mul().local_set(f_t5)
    c.local_get(f_qy).local_get(f_qz).f32_mul().local_set(f_t6)
    c.local_get(f_qw).local_get(f_qx).f32_mul().local_set(f_t7)
    c.local_get(f_qw).local_get(f_qy).f32_mul().local_set(f_t8)
    c.local_get(f_qw).local_get(f_qz).f32_mul().local_set(f_t9)

    c.f32(1.0).f32(2.0).local_get(f_t2).local_get(f_t3).f32_add().f32_mul().f32_sub().local_set(f_r00)
    c.f32(2.0).local_get(f_t4).local_get(f_t9).f32_add().f32_mul().local_set(f_r10)
    c.f32(2.0).local_get(f_t5).local_get(f_t8).f32_sub().f32_mul().local_set(f_r20)

    c.f32(2.0).local_get(f_t4).local_get(f_t9).f32_sub().f32_mul().local_set(f_r01)
    c.f32(1.0).f32(2.0).local_get(f_t1).local_get(f_t3).f32_add().f32_mul().f32_sub().local_set(f_r11)
    c.f32(2.0).local_get(f_t6).local_get(f_t7).f32_add().f32_mul().local_set(f_r21)

    c.f32(2.0).local_get(f_t5).local_get(f_t8).f32_add().f32_mul().local_set(f_r02)
    c.f32(2.0).local_get(f_t6).local_get(f_t7).f32_sub().f32_mul().local_set(f_r12)
    c.f32(1.0).f32(2.0).local_get(f_t1).local_get(f_t2).f32_add().f32_mul().f32_sub().local_set(f_r22)

    # num_x (t1), num_y (t2), num_z (t3)
    c.local_get(f_r10).local_get(f_a20).f32_mul().local_get(f_r20).local_get(f_a10).f32_mul().f32_sub()
    c.local_get(f_r11).local_get(f_a21).f32_mul().local_get(f_r21).local_get(f_a11).f32_mul().f32_sub().f32_add()
    c.local_get(f_r12).local_get(f_a22).f32_mul().local_get(f_r22).local_get(f_a12).f32_mul().f32_sub().f32_add().local_set(f_t1)

    c.local_get(f_r20).local_get(f_a00).f32_mul().local_get(f_r00).local_get(f_a20).f32_mul().f32_sub()
    c.local_get(f_r21).local_get(f_a01).f32_mul().local_get(f_r01).local_get(f_a21).f32_mul().f32_sub().f32_add()
    c.local_get(f_r22).local_get(f_a02).f32_mul().local_get(f_r02).local_get(f_a22).f32_mul().f32_sub().f32_add().local_set(f_t2)

    c.local_get(f_r00).local_get(f_a10).f32_mul().local_get(f_r10).local_get(f_a00).f32_mul().f32_sub()
    c.local_get(f_r01).local_get(f_a11).f32_mul().local_get(f_r11).local_get(f_a01).f32_mul().f32_sub().f32_add()
    c.local_get(f_r02).local_get(f_a12).f32_mul().local_get(f_r12).local_get(f_a02).f32_mul().f32_sub().f32_add().local_set(f_t3)

    # denom (t4) = |trace(R^T A)| + 1e-7
    c.local_get(f_r00).local_get(f_a00).f32_mul()
    for r, a in (
        (f_r10, f_a10), (f_r20, f_a20),
        (f_r01, f_a01), (f_r11, f_a11), (f_r21, f_a21),
        (f_r02, f_a02), (f_r12, f_a12), (f_r22, f_a22),
    ):
        c.local_get(r).local_get(a).f32_mul().f32_add()
    c.f32_abs().f32(1e-7).f32_add().local_set(f_t4)

    # ox, oy, oz -> t1, t2, t3; w2 -> t5
    c.local_get(f_t1).local_get(f_t4).f32_div().local_set(f_t1)
    c.local_get(f_t2).local_get(f_t4).f32_div().local_set(f_t2)
    c.local_get(f_t3).local_get(f_t4).f32_div().local_set(f_t3)

    c.local_get(f_t1).local_get(f_t1).f32_mul()
    c.local_get(f_t2).local_get(f_t2).f32_mul().f32_add()
    c.local_get(f_t3).local_get(f_t3).f32_mul().f32_add().local_set(f_t5)

    c.local_get(f_t5).f32(1e-10).f32_gt()
    c.if_()
    c.local_get(f_t5).f32(1.0).f32_gt()
    c.if_()
    c.f32(1.0).local_get(f_t5).f32_sqrt().f32_div().local_set(f_t6)
    c.local_get(f_t1).local_get(f_t6).f32_mul().local_set(f_t1)
    c.local_get(f_t2).local_get(f_t6).f32_mul().local_set(f_t2)
    c.local_get(f_t3).local_get(f_t6).f32_mul().local_set(f_t3)
    c.end()

    # hx=t1*0.5, hy=t2*0.5, hz=t3*0.5
    c.local_get(f_t1).f32(0.5).f32_mul().local_set(f_t1)
    c.local_get(f_t2).f32(0.5).f32_mul().local_set(f_t2)
    c.local_get(f_t3).f32(0.5).f32_mul().local_set(f_t3)

    # nqx(t6), nqy(t7), nqz(t8), nqw(t9) = dq * q
    c.local_get(f_t1).local_get(f_qw).f32_mul().local_get(f_qx).f32_add()
    c.local_get(f_t2).local_get(f_qz).f32_mul().f32_add()
    c.local_get(f_t3).local_get(f_qy).f32_mul().f32_sub().local_set(f_t6)

    c.local_get(f_t2).local_get(f_qw).f32_mul().local_get(f_qy).f32_add()
    c.local_get(f_t3).local_get(f_qx).f32_mul().f32_add()
    c.local_get(f_t1).local_get(f_qz).f32_mul().f32_sub().local_set(f_t7)

    c.local_get(f_t3).local_get(f_qw).f32_mul().local_get(f_qz).f32_add()
    c.local_get(f_t1).local_get(f_qy).f32_mul().f32_add()
    c.local_get(f_t2).local_get(f_qx).f32_mul().f32_sub().local_set(f_t8)

    c.local_get(f_qw)
    c.local_get(f_t1).local_get(f_qx).f32_mul().f32_sub()
    c.local_get(f_t2).local_get(f_qy).f32_mul().f32_sub()
    c.local_get(f_t3).local_get(f_qz).f32_mul().f32_sub().local_set(f_t9)

    c.local_get(f_t6).local_get(f_t6).f32_mul()
    c.local_get(f_t7).local_get(f_t7).f32_mul().f32_add()
    c.local_get(f_t8).local_get(f_t8).f32_mul().f32_add()
    c.local_get(f_t9).local_get(f_t9).f32_mul().f32_add().f32_sqrt().local_set(f_t10)

    c.local_get(f_t10).f32(1e-6).f32_gt()
    c.if_()
    c.f32(1.0).local_get(f_t10).f32_div().local_set(f_t11)
    c.local_get(f_t6).local_get(f_t11).f32_mul().local_set(f_qx)
    c.local_get(f_t7).local_get(f_t11).f32_mul().local_set(f_qy)
    c.local_get(f_t8).local_get(f_t11).f32_mul().local_set(f_qz)
    c.local_get(f_t9).local_get(f_t11).f32_mul().local_set(f_qw)
    c.end()

    c.else_()
    c.br(2)  # converged, break rit loop (if=0, loop=1, block=2 -> br 2 exits block)
    c.end()

    c.local_get(rit_l).i32(1).i32_add().local_set(rit_l)
    c.br(0).end().end()  # end rit loop

    # Store q -> rot[i*4]
    c.local_get(8).local_get(i_l).i32(4).i32_shl().i32_add().local_set(ptr_l)
    c.local_get(ptr_l).local_get(f_qx).f32_store(0)
    c.local_get(ptr_l).local_get(f_qy).f32_store(4)
    c.local_get(ptr_l).local_get(f_qz).f32_store(8)
    c.local_get(ptr_l).local_get(f_qw).f32_store(12)

    c.local_get(i_l).i32(1).i32_add().local_set(i_l)
    c.br(0).end().end()  # end local step i

    # ===== 2. GLOBAL STEP (3D Quaternion Rotation Projection) =====
    c.i32(0).local_set(i_l)
    c.block().loop()
    c.local_get(i_l).local_get(0).i32_ge_s().br_if(1)

    c.local_get(i_l).i32(12).i32_mul().local_set(poff_l)

    c.local_get(6).local_get(i_l).i32(2).i32_shl().i32_add().i32_load()
    c.i32(0).i32_ne()
    c.if_()
    c.local_get(4).local_get(poff_l).i32_add().local_set(ptr_l)
    c.local_get(7).local_get(poff_l).i32_add().local_set(joff_l)
    c.local_get(ptr_l).local_get(joff_l).f32_load(0).f32_store(0)
    c.local_get(ptr_l).local_get(joff_l).f32_load(4).f32_store(4)
    c.local_get(ptr_l).local_get(joff_l).f32_load(8).f32_store(8)
    c.else_()

    c.local_get(1).local_get(i_l).i32(2).i32_shl().i32_add().local_tee(ptr_l).i32_load().local_set(start_l)
    c.local_get(ptr_l).i32_load(4).local_set(end_l)

    c.local_get(8).local_get(i_l).i32(4).i32_shl().i32_add().local_tee(ptr_l).f32_load(0).local_set(f_qx)
    c.local_get(ptr_l).f32_load(4).local_set(f_qy)
    c.local_get(ptr_l).f32_load(8).local_set(f_qz)
    c.local_get(ptr_l).f32_load(12).local_set(f_qw)

    c.local_get(5).local_get(poff_l).i32_add().local_tee(ptr_l).f32_load(0).local_set(f_rx)
    c.local_get(ptr_l).f32_load(4).local_set(f_ry)
    c.local_get(ptr_l).f32_load(8).local_set(f_rz)

    c.f32(0.0).local_set(f_sx).f32(0.0).local_set(f_sy).f32(0.0).local_set(f_sz).f32(0.0).local_set(f_sw)

    c.local_get(start_l).local_set(k_l)
    c.block().loop()
    c.local_get(k_l).local_get(end_l).i32_ge_s().br_if(1)

    c.local_get(3).local_get(k_l).i32(2).i32_shl().i32_add().f32_load().local_set(f_w)
    c.local_get(2).local_get(k_l).i32(2).i32_shl().i32_add().i32_load().local_set(j_l)
    c.local_get(j_l).i32(12).i32_mul().local_set(joff_l)

    c.local_get(8).local_get(j_l).i32(4).i32_shl().i32_add().local_tee(ptr_l).f32_load(0).local_set(f_qjx)
    c.local_get(ptr_l).f32_load(4).local_set(f_qjy)
    c.local_get(ptr_l).f32_load(8).local_set(f_qjz)
    c.local_get(ptr_l).f32_load(12).local_set(f_qjw)

    c.local_get(5).local_get(joff_l).i32_add().local_set(ptr_l)
    c.local_get(f_rx).local_get(ptr_l).f32_load(0).f32_sub().local_set(f_drx)
    c.local_get(f_ry).local_get(ptr_l).f32_load(4).f32_sub().local_set(f_dry)
    c.local_get(f_rz).local_get(ptr_l).f32_load(8).f32_sub().local_set(f_drz)

    # Rotate dr by q_i -> (t4, t5, t6) using t1, t2, t3 = 2*(q_i.xyz x dr)
    c.f32(2.0).local_get(f_qy).local_get(f_drz).f32_mul().local_get(f_qz).local_get(f_dry).f32_mul().f32_sub().f32_mul().local_set(f_t1)
    c.f32(2.0).local_get(f_qz).local_get(f_drx).f32_mul().local_get(f_qx).local_get(f_drz).f32_mul().f32_sub().f32_mul().local_set(f_t2)
    c.f32(2.0).local_get(f_qx).local_get(f_dry).f32_mul().local_get(f_qy).local_get(f_drx).f32_mul().f32_sub().f32_mul().local_set(f_t3)

    c.local_get(f_drx).local_get(f_qw).local_get(f_t1).f32_mul().f32_add()
    c.local_get(f_qy).local_get(f_t3).f32_mul().local_get(f_qz).local_get(f_t2).f32_mul().f32_sub().f32_add().local_set(f_t4)
    c.local_get(f_dry).local_get(f_qw).local_get(f_t2).f32_mul().f32_add()
    c.local_get(f_qz).local_get(f_t1).f32_mul().local_get(f_qx).local_get(f_t3).f32_mul().f32_sub().f32_add().local_set(f_t5)
    c.local_get(f_drz).local_get(f_qw).local_get(f_t3).f32_mul().f32_add()
    c.local_get(f_qx).local_get(f_t2).f32_mul().local_get(f_qy).local_get(f_t1).f32_mul().f32_sub().f32_add().local_set(f_t6)

    # Rotate dr by q_j -> (t10, t11, t12) using t7, t8, t9 = 2*(q_j.xyz x dr)
    c.f32(2.0).local_get(f_qjy).local_get(f_drz).f32_mul().local_get(f_qjz).local_get(f_dry).f32_mul().f32_sub().f32_mul().local_set(f_t7)
    c.f32(2.0).local_get(f_qjz).local_get(f_drx).f32_mul().local_get(f_qjx).local_get(f_drz).f32_mul().f32_sub().f32_mul().local_set(f_t8)
    c.f32(2.0).local_get(f_qjx).local_get(f_dry).f32_mul().local_get(f_qjy).local_get(f_drx).f32_mul().f32_sub().f32_mul().local_set(f_t9)

    c.local_get(f_drx).local_get(f_qjw).local_get(f_t7).f32_mul().f32_add()
    c.local_get(f_qjy).local_get(f_t9).f32_mul().local_get(f_qjz).local_get(f_t8).f32_mul().f32_sub().f32_add().local_set(f_t10)
    c.local_get(f_dry).local_get(f_qjw).local_get(f_t8).f32_mul().f32_add()
    c.local_get(f_qjz).local_get(f_t7).f32_mul().local_get(f_qjx).local_get(f_t9).f32_mul().f32_sub().f32_add().local_set(f_t11)
    c.local_get(f_drz).local_get(f_qjw).local_get(f_t9).f32_mul().f32_add()
    c.local_get(f_qjx).local_get(f_t8).f32_mul().local_get(f_qjy).local_get(f_t7).f32_mul().f32_sub().f32_add().local_set(f_t12)

    c.local_get(4).local_get(joff_l).i32_add().local_set(ptr_l)

    c.local_get(f_sx).local_get(f_w)
    c.local_get(ptr_l).f32_load(0).f32(0.5).local_get(f_t4).local_get(f_t10).f32_add().f32_mul().f32_add()
    c.f32_mul().f32_add().local_set(f_sx)

    c.local_get(f_sy).local_get(f_w)
    c.local_get(ptr_l).f32_load(4).f32(0.5).local_get(f_t5).local_get(f_t11).f32_add().f32_mul().f32_add()
    c.f32_mul().f32_add().local_set(f_sy)

    c.local_get(f_sz).local_get(f_w)
    c.local_get(ptr_l).f32_load(8).f32(0.5).local_get(f_t6).local_get(f_t12).f32_add().f32_mul().f32_add()
    c.f32_mul().f32_add().local_set(f_sz)

    c.local_get(f_sw).local_get(f_w).f32_add().local_set(f_sw)

    c.local_get(k_l).i32(1).i32_add().local_set(k_l)
    c.br(0).end().end()  # end k

    c.local_get(f_sw).f32(1e-6).f32_gt()
    c.if_()
    c.f32(1.0).local_get(f_sw).f32_div().local_set(f_inv)
    c.local_get(4).local_get(poff_l).i32_add().local_set(ptr_l)

    c.local_get(ptr_l).f32_load(0).local_set(f_px)
    c.local_get(ptr_l)
    c.local_get(f_px).local_get(10)
    c.local_get(f_sx).local_get(f_inv).f32_mul().local_get(f_px).f32_sub()
    c.f32_mul().f32_add().f32_store(0)

    c.local_get(ptr_l).f32_load(4).local_set(f_py)
    c.local_get(ptr_l)
    c.local_get(f_py).local_get(10)
    c.local_get(f_sy).local_get(f_inv).f32_mul().local_get(f_py).f32_sub()
    c.f32_mul().f32_add().f32_store(4)

    c.local_get(ptr_l).f32_load(8).local_set(f_pz)
    c.local_get(ptr_l)
    c.local_get(f_pz).local_get(10)
    c.local_get(f_sz).local_get(f_inv).f32_mul().local_get(f_pz).f32_sub()
    c.f32_mul().f32_add().f32_store(8)

    c.end()  # end if sw > 1e-6
    c.end()  # end if pin_flag

    c.local_get(i_l).i32(1).i32_add().local_set(i_l)
    c.br(0).end().end()  # end global step i

    c.local_get(iter_l).i32(1).i32_add().local_set(iter_l)
    c.br(0).end().end()  # end outer iter

    return c.build([(10, I32), (48, F32)])


def build_softbody_verlet() -> bytes:
    # Params:
    # 0: vert_count (i32)
    # 1: adj_off_ptr (i32)
    # 2: adj_idx_ptr (i32)
    # 3: adj_w_ptr (i32)
    # 4: pos_ptr (i32)
    # 5: prev_ptr (i32)
    # 6: target_ptr (i32)
    # 7: pin_flag_ptr (i32)
    # 8: stiffness (f32)
    # 9: damping (f32)
    # 10: couple (f32)
    #
    # Locals:
    # 11..21 (11 i32): i, poff, pptr, prptr, tptr, start, end, k, joff, ptr_tmp, jtptr
    # 22..50 (29 f32): px..jpz
    c = Code()
    i_l, poff_l, pptr, prptr, tptr = 11, 12, 13, 14, 15
    start_l, end_l, k_l, joff_l, ptr_l, jtptr = 16, 17, 18, 19, 20, 21
    px, py, pz, vx, vy, vz = 22, 23, 24, 25, 26, 27
    tx, ty, tz, sx, sy, sz, sw = 28, 29, 30, 31, 32, 33, 34
    w_l, inv_l, dx_l, dy_l, dz_l = 35, 36, 37, 38, 39
    ux_l, uy_l, uz_l, uxs, uys, uzs = 40, 41, 42, 43, 44, 45
    edge_k, vel_k, jpx, jpy, jpz = 46, 47, 48, 49, 50

    c.local_get(0).i32(0).op(0x4C).if_().op(0x0F).end()

    # ===== PASS 1: Pure Verlet Spring Step =====
    c.i32(0).local_set(i_l)
    c.block().loop()
    c.local_get(i_l).local_get(0).i32_ge_s().br_if(1)

    c.local_get(i_l).i32(12).i32_mul().local_set(poff_l)
    c.local_get(4).local_get(poff_l).i32_add().local_set(pptr)
    c.local_get(5).local_get(poff_l).i32_add().local_set(prptr)
    c.local_get(6).local_get(poff_l).i32_add().local_set(tptr)

    c.local_get(7).local_get(i_l).i32(2).i32_shl().i32_add().i32_load()
    c.i32(0).i32_ne()
    c.if_()
    c.local_get(tptr).f32_load(0).local_set(px)
    c.local_get(tptr).f32_load(4).local_set(py)
    c.local_get(tptr).f32_load(8).local_set(pz)
    c.local_get(pptr).local_get(px).f32_store(0)
    c.local_get(pptr).local_get(py).f32_store(4)
    c.local_get(pptr).local_get(pz).f32_store(8)
    c.local_get(prptr).local_get(px).f32_store(0)
    c.local_get(prptr).local_get(py).f32_store(4)
    c.local_get(prptr).local_get(pz).f32_store(8)
    c.else_()

    c.local_get(pptr).f32_load(0).local_set(px)
    c.local_get(pptr).f32_load(4).local_set(py)
    c.local_get(pptr).f32_load(8).local_set(pz)

    c.local_get(px).local_get(prptr).f32_load(0).f32_sub().local_get(9).f32_mul().local_set(vx)
    c.local_get(py).local_get(prptr).f32_load(4).f32_sub().local_get(9).f32_mul().local_set(vy)
    c.local_get(pz).local_get(prptr).f32_load(8).f32_sub().local_get(9).f32_mul().local_set(vz)

    c.local_get(prptr).local_get(px).f32_store(0)
    c.local_get(prptr).local_get(py).f32_store(4)
    c.local_get(prptr).local_get(pz).f32_store(8)

    c.local_get(pptr)
    c.local_get(px).local_get(vx).f32_add()
    c.local_get(tptr).f32_load(0).local_get(px).f32_sub().local_get(8).f32_mul()
    c.f32_add().f32_store(0)

    c.local_get(pptr)
    c.local_get(py).local_get(vy).f32_add()
    c.local_get(tptr).f32_load(4).local_get(py).f32_sub().local_get(8).f32_mul()
    c.f32_add().f32_store(4)

    c.local_get(pptr)
    c.local_get(pz).local_get(vz).f32_add()
    c.local_get(tptr).f32_load(8).local_get(pz).f32_sub().local_get(8).f32_mul()
    c.f32_add().f32_store(8)

    c.end()

    c.local_get(i_l).i32(1).i32_add().local_set(i_l)
    c.br(0).end().end()  # end pass 1

    # ===== PASS 2: Edge-Coupled Elastic Displacement Wave & Kinetic Velocity Transfer =====
    c.local_get(10).f32(1e-4).f32_gt()
    c.if_()

    # edge_k = min(0.44, couple * 1.15); vel_k = couple * 0.65
    c.local_get(10).f32(1.15).f32_mul().local_tee(edge_k).f32(0.44).f32_gt()
    c.if_()
    c.f32(0.44).local_set(edge_k)
    c.end()
    c.local_get(10).f32(0.65).f32_mul().local_set(vel_k)

    c.i32(0).local_set(i_l)
    c.block().loop()
    c.local_get(i_l).local_get(0).i32_ge_s().br_if(1)

    c.local_get(7).local_get(i_l).i32(2).i32_shl().i32_add().i32_load()
    c.i32(0).i32_eq()
    c.if_()

    c.local_get(i_l).i32(12).i32_mul().local_set(poff_l)
    c.local_get(4).local_get(poff_l).i32_add().local_set(pptr)
    c.local_get(5).local_get(poff_l).i32_add().local_set(tptr)   # prev[i]
    c.local_get(6).local_get(poff_l).i32_add().local_set(jtptr)  # target[i]

    c.local_get(pptr).f32_load(0).local_set(px)
    c.local_get(pptr).f32_load(4).local_set(py)
    c.local_get(pptr).f32_load(8).local_set(pz)
    c.local_get(tptr).f32_load(0).local_set(tx)
    c.local_get(tptr).f32_load(4).local_set(ty)
    c.local_get(tptr).f32_load(8).local_set(tz)

    c.local_get(px).local_get(tx).f32_sub().local_set(dx_l)
    c.local_get(py).local_get(ty).f32_sub().local_set(dy_l)
    c.local_get(pz).local_get(tz).f32_sub().local_set(dz_l)

    c.local_get(px).local_get(jtptr).f32_load(0).f32_sub().local_set(uxs)
    c.local_get(py).local_get(jtptr).f32_load(4).f32_sub().local_set(uys)
    c.local_get(pz).local_get(jtptr).f32_load(8).f32_sub().local_set(uzs)

    c.local_get(1).local_get(i_l).i32(2).i32_shl().i32_add().local_tee(ptr_l).i32_load().local_set(start_l)
    c.local_get(ptr_l).i32_load(4).local_set(end_l)

    c.f32(0.0).local_set(sx).f32(0.0).local_set(sy).f32(0.0).local_set(sz)
    c.f32(0.0).local_set(ux_l).f32(0.0).local_set(uy_l).f32(0.0).local_set(uz_l)
    c.f32(0.0).local_set(sw)
    c.local_get(start_l).local_set(k_l)

    c.block().loop()
    c.local_get(k_l).local_get(end_l).i32_ge_s().br_if(1)

    c.local_get(3).local_get(k_l).i32(2).i32_shl().i32_add().f32_load().local_set(w_l)
    c.local_get(2).local_get(k_l).i32(2).i32_shl().i32_add().i32_load().i32(12).i32_mul().local_set(joff_l)

    c.local_get(4).local_get(joff_l).i32_add().local_tee(ptr_l)
    c.f32_load(0).local_set(jpx)
    c.local_get(ptr_l).f32_load(4).local_set(jpy)
    c.local_get(ptr_l).f32_load(8).local_set(jpz)

    c.local_get(5).local_get(joff_l).i32_add().local_set(ptr_l)
    c.local_get(sx).local_get(w_l).local_get(jpx).local_get(ptr_l).f32_load(0).f32_sub().f32_mul().f32_add().local_set(sx)
    c.local_get(sy).local_get(w_l).local_get(jpy).local_get(ptr_l).f32_load(4).f32_sub().f32_mul().f32_add().local_set(sy)
    c.local_get(sz).local_get(w_l).local_get(jpz).local_get(ptr_l).f32_load(8).f32_sub().f32_mul().f32_add().local_set(sz)

    c.local_get(6).local_get(joff_l).i32_add().local_set(ptr_l)
    c.local_get(ux_l).local_get(w_l).local_get(jpx).local_get(ptr_l).f32_load(0).f32_sub().f32_mul().f32_add().local_set(ux_l)
    c.local_get(uy_l).local_get(w_l).local_get(jpy).local_get(ptr_l).f32_load(4).f32_sub().f32_mul().f32_add().local_set(uy_l)
    c.local_get(uz_l).local_get(w_l).local_get(jpz).local_get(ptr_l).f32_load(8).f32_sub().f32_mul().f32_add().local_set(uz_l)

    c.local_get(sw).local_get(w_l).f32_add().local_set(sw)

    c.local_get(k_l).i32(1).i32_add().local_set(k_l)
    c.br(0).end().end()  # end k

    c.local_get(sw).f32(1e-6).f32_gt()
    c.if_()
    c.f32(1.0).local_get(sw).f32_div().local_set(inv_l)

    c.local_get(pptr)
    c.local_get(px)
    c.local_get(sx).local_get(inv_l).f32_mul().local_get(dx_l).f32_sub().local_get(vel_k).f32_mul().f32_add()
    c.local_get(ux_l).local_get(inv_l).f32_mul().local_get(uxs).f32_sub().local_get(edge_k).f32_mul().f32_add()
    c.f32_store(0)

    c.local_get(pptr)
    c.local_get(py)
    c.local_get(sy).local_get(inv_l).f32_mul().local_get(dy_l).f32_sub().local_get(vel_k).f32_mul().f32_add()
    c.local_get(uy_l).local_get(inv_l).f32_mul().local_get(uys).f32_sub().local_get(edge_k).f32_mul().f32_add()
    c.f32_store(4)

    c.local_get(pptr)
    c.local_get(pz)
    c.local_get(sz).local_get(inv_l).f32_mul().local_get(dz_l).f32_sub().local_get(vel_k).f32_mul().f32_add()
    c.local_get(uz_l).local_get(inv_l).f32_mul().local_get(uzs).f32_sub().local_get(edge_k).f32_mul().f32_add()
    c.f32_store(8)

    c.end()  # end if sw
    c.end()  # end if pin_flag == 0

    c.local_get(i_l).i32(1).i32_add().local_set(i_l)
    c.br(0).end().end()  # end pass 2

    c.end()  # end if couple > 1e-4

    return c.build([(11, I32), (29, F32)])


def emit_wasm() -> bytes:
    # Type section:
    # 0: poisson_relax: (i32,i32,i32,i32,i32,i32,f32,f32,i32) -> ()
    # 1: arap_step: (i32,i32,i32,i32,i32,i32,i32,i32,i32,i32,f32) -> ()
    # 2: softbody_verlet: (i32,i32,i32,i32,i32,i32,i32,i32,f32,f32,f32) -> ()
    def ftype(params: list[int]) -> bytes:
        return b"\x60" + uleb(len(params)) + bytes(params) + b"\x00"

    t0 = ftype([I32, I32, I32, I32, I32, I32, F32, F32, I32])
    t1 = ftype([I32, I32, I32, I32, I32, I32, I32, I32, I32, I32, F32])
    t2 = ftype([I32, I32, I32, I32, I32, I32, I32, I32, F32, F32, F32])
    sec_type = section(1, vec([t0, t1, t2]))

    # Import section: env.memory (limits: flags=1 min=64 max=512)
    mem_import = name("env") + name("memory") + b"\x02\x01" + uleb(64) + uleb(512)
    sec_import = section(2, vec([mem_import]))

    # Function section: [0, 1, 2]
    sec_func = section(3, vec([uleb(0), uleb(1), uleb(2)]))

    # Export section
    e0 = name("poisson_relax") + b"\x00" + uleb(0)
    e1 = name("arap_step") + b"\x00" + uleb(1)
    e2 = name("softbody_verlet") + b"\x00" + uleb(2)
    sec_export = section(7, vec([e0, e1, e2]))

    # Code section
    c0 = build_poisson_relax()
    c1 = build_arap_step()
    c2 = build_softbody_verlet()
    sec_code = section(10, vec([c0, c1, c2]))

    return b"\x00asm\x01\x00\x00\x00" + sec_type + sec_import + sec_func + sec_export + sec_code


if __name__ == "__main__":
    out_path = os.path.join(os.path.dirname(__file__), "..", "public", "wasm", "mesh_solver.wasm")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    wasm_bytes = emit_wasm()
    with open(out_path, "wb") as f:
        f.write(wasm_bytes)
    print(f"Wrote {len(wasm_bytes)} bytes to {out_path}")
