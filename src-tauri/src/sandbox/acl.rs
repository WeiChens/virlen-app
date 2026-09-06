//! NTFS ACL 维护（对应 codex acl.rs）。
//!
//! 职责：
//!   1. 对「可写根」目录授予工作区能力 SID 的 Allow-Write（含继承）；
//!   2. 对可写根内部的保护子路径(.git/.codex/...)添加 Deny-Write；
//!   3. 让能力 SID 可以写 `\\.\NUL`（cmd 重定向需要）。
//!
//! 全部操作幂等：先检查已有 ACE，避免每次运行都重写 DACL。
use std::ffi::c_void;
use std::mem;
use std::path::Path;

use anyhow::{anyhow, Result};
use windows_sys::Win32::Foundation::{ERROR_SUCCESS, HLOCAL, LocalFree};
use windows_sys::Win32::Security::{
    ACL, ACCESS_ALLOWED_ACE, ACCESS_DENIED_ACE, ACE_HEADER, ACL_SIZE_INFORMATION, AclSizeInformation,
    DACL_SECURITY_INFORMATION, EqualSid, GENERIC_MAPPING, GetAce, GetAclInformation, MapGenericMask,
};
use windows_sys::Win32::Security::Authorization::{
    EXPLICIT_ACCESS_W, GetNamedSecurityInfoW, GetSecurityInfo, SetEntriesInAclW,
    SetNamedSecurityInfoW, SetSecurityInfo, TRUSTEE_IS_SID, TRUSTEE_IS_UNKNOWN, TRUSTEE_W,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, DELETE, FILE_ALL_ACCESS, FILE_APPEND_DATA, FILE_ATTRIBUTE_NORMAL, FILE_DELETE_CHILD,
    FILE_GENERIC_EXECUTE, FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    FILE_WRITE_ATTRIBUTES, FILE_WRITE_DATA, FILE_WRITE_EA, OPEN_EXISTING,
};

use crate::sandbox::spawn::to_wide;

const INHERIT_ONLY_ACE: u8 = 0x08;
const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
const ACCESS_DENIED_ACE_TYPE: u8 = 1;
const CONTAINER_INHERIT_ACE: u32 = 0x2;
const OBJECT_INHERIT_ACE: u32 = 0x1;
const SE_FILE_OBJECT: i32 = 1;
const SE_KERNEL_OBJECT: i32 = 6;
const SET_ACCESS: u32 = 2; // GRANT_ACCESS=1 SET_ACCESS=2 DENY_ACCESS=3 REVOKE_ACCESS=4
const DENY_ACCESS: u32 = 3;

const GENERIC_WRITE_MASK: u32 = 0x4000_0000;

/// 写允许掩码：读写执行 + DELETE（不授 FILE_DELETE_CHILD，防止越过子目录 deny）。
const WRITE_ALLOW_MASK: u32 =
    FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE;

/// Deny-Write 掩码（含删除、子级删除、属性/EA 写入）。
fn deny_write_mask() -> u32 {
    FILE_GENERIC_WRITE
        | FILE_WRITE_DATA
        | FILE_APPEND_DATA
        | FILE_WRITE_EA
        | FILE_WRITE_ATTRIBUTES
        | GENERIC_WRITE_MASK
        | DELETE
        | FILE_DELETE_CHILD
}

/// 取得路径当前 DACL；返回 (dacl, security_descriptor)，sd 需 LocalFree。
fn fetch_dacl(path: &Path) -> Result<(*mut ACL, *mut c_void)> {
    let mut p_sd: *mut c_void = std::ptr::null_mut();
    let mut p_dacl: *mut ACL = std::ptr::null_mut();
    let code = unsafe {
        GetNamedSecurityInfoW(
            to_wide(path).as_ptr() as *mut u16,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut p_dacl,
            std::ptr::null_mut(),
            &mut p_sd,
        )
    };
    if code != ERROR_SUCCESS {
        if !p_sd.is_null() {
            unsafe { LocalFree(p_sd as HLOCAL) };
        }
        return Err(anyhow!(
            "GetNamedSecurityInfoW failed for {}: {code}",
            path.display()
        ));
    }
    Ok((p_dacl, p_sd))
}

fn free_sd(p_sd: *mut c_void) {
    if !p_sd.is_null() {
        // SAFETY: 由 GetNamedSecurityInfoW 分配的 SD。
        unsafe { LocalFree(p_sd as HLOCAL) };
    }
}

fn ace_sid_ptr(p_ace: *mut c_void) -> *mut c_void {
    // ACE 布局: ACE_HEADER(4) + Mask(4) + SidStart...
    (p_ace as usize + mem::size_of::<ACE_HEADER>() + mem::size_of::<u32>()) as *mut c_void
}

/// 当前 DACL 中是否存在授予 psid 的 allow ACE，其掩码包含所需位。
/// require_all_bits=true 要求全部位都具备。
fn dacl_has_allow_for_sid(
    p_dacl: *mut ACL,
    psid: *mut c_void,
    desired_mask: u32,
    require_all_bits: bool,
) -> bool {
    if p_dacl.is_null() {
        return false;
    }
    // SAFETY: p_dacl 来自系统调用。
    let mut info: ACL_SIZE_INFORMATION = unsafe { mem::zeroed() };
    let ok = unsafe {
        GetAclInformation(
            p_dacl as *const ACL,
            &mut info as *mut _ as *mut c_void,
            mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
            AclSizeInformation,
        )
    };
    if ok == 0 {
        return false;
    }
    let mapping = GENERIC_MAPPING {
        GenericRead: FILE_GENERIC_READ,
        GenericWrite: FILE_GENERIC_WRITE,
        GenericExecute: FILE_GENERIC_EXECUTE,
        GenericAll: FILE_ALL_ACCESS,
    };
    for i in 0..info.AceCount {
        let mut p_ace: *mut c_void = std::ptr::null_mut();
        if unsafe { GetAce(p_dacl as *const ACL, i, &mut p_ace) } == 0 {
            continue;
        }
        // SAFETY: p_ace 指向有效 ACE。
        let hdr = unsafe { &*(p_ace as *const ACE_HEADER) };
        if hdr.AceType != ACCESS_ALLOWED_ACE_TYPE || (hdr.AceFlags & INHERIT_ONLY_ACE) != 0 {
            continue;
        }
        let ps = ace_sid_ptr(p_ace);
        if unsafe { EqualSid(ps, psid) } == 0 {
            continue;
        }
        // SAFETY: p_ace 为 ACCESS_ALLOWED_ACE。
        let ace = unsafe { &*(p_ace as *const ACCESS_ALLOWED_ACE) };
        let mut mask = ace.Mask;
        unsafe { MapGenericMask(&mut mask, &mapping) };
        if (require_all_bits && (mask & desired_mask) == desired_mask)
            || (!require_all_bits && (mask & desired_mask) != 0)
        {
            return true;
        }
    }
    false
}

/// 是否存在针对 psid 的 deny ACE（写掩码）。
fn dacl_has_write_deny_for_sid(p_dacl: *mut ACL, psid: *mut c_void) -> bool {
    if p_dacl.is_null() {
        return false;
    }
    // SAFETY: p_dacl 来自系统调用。
    let mut info: ACL_SIZE_INFORMATION = unsafe { mem::zeroed() };
    let ok = unsafe {
        GetAclInformation(
            p_dacl as *const ACL,
            &mut info as *mut _ as *mut c_void,
            mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
            AclSizeInformation,
        )
    };
    if ok == 0 {
        return false;
    }
    let deny_mask = deny_write_mask();
    for i in 0..info.AceCount {
        let mut p_ace: *mut c_void = std::ptr::null_mut();
        if unsafe { GetAce(p_dacl as *const ACL, i, &mut p_ace) } == 0 {
            continue;
        }
        // SAFETY: p_ace 指向有效 ACE。
        let hdr = unsafe { &*(p_ace as *const ACE_HEADER) };
        if hdr.AceType != ACCESS_DENIED_ACE_TYPE || (hdr.AceFlags & INHERIT_ONLY_ACE) != 0 {
            continue;
        }
        let ps = ace_sid_ptr(p_ace);
        if unsafe { EqualSid(ps, psid) } == 0 {
            continue;
        }
        // SAFETY: p_ace 为 ACCESS_DENIED_ACE。
        let ace = unsafe { &*(p_ace as *const ACCESS_DENIED_ACE) };
        if (ace.Mask & deny_mask) != 0 {
            return true;
        }
    }
    false
}

fn apply_one_ace(path: &Path, psid: *mut c_void, access_mode: u32, mask: u32) -> Result<bool> {
    let (p_dacl, p_sd) = fetch_dacl(path)?;
    let trustee = TRUSTEE_W {
        pMultipleTrustee: std::ptr::null_mut(),
        MultipleTrusteeOperation: 0,
        TrusteeForm: TRUSTEE_IS_SID,
        TrusteeType: TRUSTEE_IS_UNKNOWN,
        ptstrName: psid as *mut u16,
    };
    let mut explicit: EXPLICIT_ACCESS_W = unsafe { mem::zeroed() };
    explicit.grfAccessPermissions = mask;
    explicit.grfAccessMode = access_mode as i32;
    explicit.grfInheritance = CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE;
    explicit.Trustee = trustee;
    let mut p_new_dacl: *mut ACL = std::ptr::null_mut();
    let code2 = unsafe { SetEntriesInAclW(1, &explicit, p_dacl, &mut p_new_dacl) };
    if code2 != ERROR_SUCCESS {
        free_sd(p_sd);
        return Err(anyhow!(
            "SetEntriesInAclW failed for {}: {code2}",
            path.display()
        ));
    }
    let code3 = unsafe {
        SetNamedSecurityInfoW(
            to_wide(path).as_ptr() as *mut u16,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            p_new_dacl,
            std::ptr::null_mut(),
        )
    };
    if !p_new_dacl.is_null() {
        // SAFETY: SetEntriesInAclW 分配。
        unsafe { LocalFree(p_new_dacl as HLOCAL) };
    }
    free_sd(p_sd);
    if code3 != ERROR_SUCCESS {
        return Err(anyhow!(
            "SetNamedSecurityInfoW failed for {}: {code3} (you must own this file or have WRITE_DAC permission)",
            path.display()
        ));
    }
    Ok(true)
}

/// 确保 path 的 DACL 中给 psid 授了完整的读写执行+删除（含继承）。
pub fn ensure_allow_write_aces(path: &Path, psid: *mut c_void) -> Result<bool> {
    let (p_dacl, p_sd) = fetch_dacl(path)?;
    let present = dacl_has_allow_for_sid(p_dacl, psid, WRITE_ALLOW_MASK, /*require_all_bits*/ true);
    free_sd(p_sd);
    if present {
        return Ok(false);
    }
    apply_one_ace(path, psid, SET_ACCESS, WRITE_ALLOW_MASK)
}

/// 确保 path 的 DACL 中给 psid 加了 Deny-Write（含继承）。
pub fn add_deny_write_ace(path: &Path, psid: *mut c_void) -> Result<bool> {
    let (p_dacl, p_sd) = fetch_dacl(path)?;
    let present = dacl_has_write_deny_for_sid(p_dacl, psid);
    free_sd(p_sd);
    if present {
        return Ok(false);
    }
    apply_one_ace(path, psid, DENY_ACCESS, deny_write_mask())
}

/// 让 psid 可以写 NUL 设备（cmd/pwsh 的 >NUL 重定向在 WRITE_RESTRICTED 令牌下会失败，
/// 除非 NUL 的 DACL 给了该能力 SID 写权限）。
pub fn allow_null_device(psid: *mut c_void) {
    let wide = to_wide(r"\\.\NUL");
    let desired = 0x0002_0000 | 0x0004_0000; // READ_CONTROL | WRITE_DAC
    let h = unsafe {
        CreateFileW(
            wide.as_ptr(),
            desired,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            std::ptr::null_mut(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            std::ptr::null_mut(),
        )
    };
    let invalid = windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    if h.is_null() || h == invalid {
        return;
    }
    // NUL 是内核对象（SE_KERNEL_OBJECT），用句柄版 API。
    let mut p_sd: *mut c_void = std::ptr::null_mut();
    let mut p_dacl: *mut ACL = std::ptr::null_mut();
    let code = unsafe {
        GetSecurityInfo(
            h,
            SE_KERNEL_OBJECT,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut p_dacl,
            std::ptr::null_mut(),
            &mut p_sd,
        )
    };
    if code == ERROR_SUCCESS && dacl_has_allow_for_sid(p_dacl, psid, FILE_GENERIC_WRITE, true) {
        // 已有
    } else if code == ERROR_SUCCESS {
        let trustee = TRUSTEE_W {
            pMultipleTrustee: std::ptr::null_mut(),
            MultipleTrusteeOperation: 0,
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_UNKNOWN,
            ptstrName: psid as *mut u16,
        };
        let mut explicit: EXPLICIT_ACCESS_W = unsafe { mem::zeroed() };
        explicit.grfAccessPermissions =
            FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE;
        explicit.grfAccessMode = SET_ACCESS as i32;
        explicit.grfInheritance = 0;
        explicit.Trustee = trustee;
        let mut p_new_dacl: *mut ACL = std::ptr::null_mut();
        let code2 = unsafe { SetEntriesInAclW(1, &explicit, p_dacl, &mut p_new_dacl) };
        if code2 == ERROR_SUCCESS {
            let code3 = unsafe {
                SetSecurityInfo(
                    h,
                    SE_KERNEL_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    p_new_dacl,
                    std::ptr::null_mut(),
                )
            };
            let _ = code3;
            if !p_new_dacl.is_null() {
                unsafe { LocalFree(p_new_dacl as HLOCAL) };
            }
        }
    }
    if !p_sd.is_null() {
        unsafe { LocalFree(p_sd as HLOCAL) };
    }
    // SAFETY: h 由 CreateFileW 打开。
    unsafe { windows_sys::Win32::Foundation::CloseHandle(h) };
}
