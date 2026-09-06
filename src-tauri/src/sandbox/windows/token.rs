//! 受限令牌构建（对应 codex token.rs 免提权部分）。
//!
//! 通过 `CreateRestrictedToken` 从当前用户令牌派生：
//!   flags = DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED
//!   restricting SIDs = [能力 SIDs..., Logon SID, Everyone]
//!
//! WRITE_RESTRICTED 语义：进程普通组（Users/管理员等）仍参与读/执行检查，
//! 但**写检查只看 restricting SID**。因此要「写入」某对象，对象 DACL 中必须
//! 有某个 restricting SID 的 Allow-Write ACE —— 这就是我们把工作区能力 SID
//! 授到目标目录 ACL 上、其它地方不给的原因。

use std::ffi::c_void;

use anyhow::{anyhow, Result};
use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_SUCCESS, GetLastError, HANDLE, HLOCAL, LocalFree,
};
use windows_sys::Win32::Security::{
    ACL, AdjustTokenPrivileges, CopySid, CreateRestrictedToken, CreateWellKnownSid, GetLengthSid,
    GetTokenInformation, LookupPrivilegeValueW, SID_AND_ATTRIBUTES, SetTokenInformation,
    TOKEN_PRIVILEGES, TokenDefaultDacl, TokenGroups,
};
use windows_sys::Win32::Security::Authorization::{
    EXPLICIT_ACCESS_W, GRANT_ACCESS, SetEntriesInAclW, TRUSTEE_IS_SID, TRUSTEE_IS_UNKNOWN,
    TRUSTEE_W,
};
use windows_sys::Win32::System::Threading::GetCurrentProcess;

const DISABLE_MAX_PRIVILEGE: u32 = 0x01;
const LUA_TOKEN: u32 = 0x04;
const WRITE_RESTRICTED: u32 = 0x08;
const GENERIC_ALL: u32 = 0x1000_0000;
const WIN_WORLD_SID: i32 = 1;
const SE_GROUP_LOGON_ID: u32 = 0xC000_0000;
const SE_PRIVILEGE_ENABLED: u32 = 0x0000_0002;
const TOKEN_LINKED_TOKEN_CLASS: i32 = 19;

// 令牌访问权限（Win32 稳定值，本地定义避免跨 windows-sys 版本差异）。
const TOKEN_ASSIGN_PRIMARY: u32 = 0x0001;
const TOKEN_DUPLICATE: u32 = 0x0002;
const TOKEN_QUERY: u32 = 0x0008;
const TOKEN_ADJUST_PRIVILEGES: u32 = 0x0020;
const TOKEN_ADJUST_DEFAULT: u32 = 0x0080;
const TOKEN_ADJUST_SESSIONID: u32 = 0x0100;

/// 持有由 `ConvertStringSidToSidW` 分配的 SID，析构时 LocalFree。
pub struct LocalSid {
    psid: *mut c_void,
}

// windows-sys 各版本的 ConvertStringSidToSidW 特性存在差异，
// 这里用本地 extern 绑定，避免跨版本特性差异。
#[link(name = "advapi32")]
unsafe extern "system" {
    fn ConvertStringSidToSidW(StringSid: *const u16, Sid: *mut *mut c_void) -> i32;
    fn OpenProcessToken(ProcessHandle: HANDLE, DesiredAccess: u32, TokenHandle: *mut HANDLE)
        -> i32;
}

impl LocalSid {
    pub fn from_string(sid: &str) -> Result<Self> {
        let wide = super::spawn::to_wide(sid);
        let mut psid: *mut c_void = std::ptr::null_mut();
        // SAFETY: 传入以 0 结尾的宽字符串指针与合法输出指针。
        let ok = unsafe { ConvertStringSidToSidW(wide.as_ptr(), &mut psid) };
        if ok == 0 {
            return Err(anyhow!("invalid SID string: {sid}"));
        }
        Ok(Self { psid })
    }

    pub fn as_ptr(&self) -> *mut c_void {
        self.psid
    }
}

impl Drop for LocalSid {
    fn drop(&mut self) {
        if !self.psid.is_null() {
            // SAFETY: psid 由 ConvertStringSidToSidW 分配，可用 LocalFree 释放。
            unsafe { LocalFree(self.psid as HLOCAL) };
        }
    }
}

/// 世界/Everyone SID 字节。
pub fn world_sid() -> Result<Vec<u8>> {
    // SAFETY: CreateWellKnownSid 两次调用（先取大小，再填充）。
    unsafe {
        let mut size: u32 = 0;
        CreateWellKnownSid(
            WIN_WORLD_SID,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut size,
        );
        let mut buf: Vec<u8> = vec![0u8; size as usize];
        let ok = CreateWellKnownSid(
            WIN_WORLD_SID,
            std::ptr::null_mut(),
            buf.as_mut_ptr() as *mut c_void,
            &mut size,
        );
        if ok == 0 {
            return Err(anyhow!("CreateWellKnownSid failed: {}", GetLastError()));
        }
        Ok(buf)
    }
}

/// 打开当前进程令牌（用于派生受限令牌）。
pub fn get_current_token_for_restriction() -> Result<HANDLE> {
    let desired = TOKEN_DUPLICATE
        | TOKEN_QUERY
        | TOKEN_ASSIGN_PRIMARY
        | TOKEN_ADJUST_DEFAULT
        | TOKEN_ADJUST_SESSIONID
        | TOKEN_ADJUST_PRIVILEGES;
    let mut h: HANDLE = std::ptr::null_mut();
    // SAFETY: 传当前进程句柄与输出句柄。
    let ok = unsafe { OpenProcessToken(GetCurrentProcess(), desired, &mut h) };
    if ok == 0 {
        let err = unsafe { GetLastError() };
        return Err(anyhow!("OpenProcessToken failed: {err}"));
    }
    Ok(h)
}

/// 从令牌中取出 Logon SID（扫描 TokenGroups，回退到 linked token）。
pub fn get_logon_sid_bytes(h_token: HANDLE) -> Result<Vec<u8>> {
    // SAFETY: h_token 为有效令牌句柄。
    unsafe {
        if let Some(v) = scan_token_groups_for_logon(h_token) {
            return Ok(v);
        }
        // 部分令牌（如服务/链接令牌）主组里没有 logon SID，尝试 linked token。
        let mut ln_needed: u32 = 0;
        GetTokenInformation(
            h_token,
            TOKEN_LINKED_TOKEN_CLASS,
            std::ptr::null_mut(),
            0,
            &mut ln_needed,
        );
        if ln_needed >= std::mem::size_of::<usize>() as u32 {
            let mut ln_buf: Vec<u8> = vec![0u8; ln_needed as usize];
            let ok = GetTokenInformation(
                h_token,
                TOKEN_LINKED_TOKEN_CLASS,
                ln_buf.as_mut_ptr() as *mut c_void,
                ln_needed,
                &mut ln_needed,
            );
            if ok != 0 {
                // TOKEN_LINKED_TOKEN 布局：单个 HANDLE。
                let linked = std::ptr::read_unaligned(ln_buf.as_ptr() as *const HANDLE);
                if !linked.is_null() {
                    let res = scan_token_groups_for_logon(linked);
                    CloseHandle(linked);
                    if let Some(v) = res {
                        return Ok(v);
                    }
                }
            }
        }
    }
    Err(anyhow!("Logon SID not present on token"))
}

// SAFETY: h_token 必须有效。
unsafe fn scan_token_groups_for_logon(h: HANDLE) -> Option<Vec<u8>> {
    let mut needed: u32 = 0;
    GetTokenInformation(h, TokenGroups, std::ptr::null_mut(), 0, &mut needed);
    if needed == 0 {
        return None;
    }
    let mut buf: Vec<u8> = vec![0u8; needed as usize];
    let ok = GetTokenInformation(
        h,
        TokenGroups,
        buf.as_mut_ptr() as *mut c_void,
        needed,
        &mut needed,
    );
    if ok == 0 || (needed as usize) < std::mem::size_of::<u32>() {
        return None;
    }
    let group_count = std::ptr::read_unaligned(buf.as_ptr() as *const u32) as usize;
    // TOKEN_GROUPS = DWORD GroupCount; SID_AND_ATTRIBUTES Groups[]（64位下有对齐）。
    let after_count = buf.as_ptr().add(std::mem::size_of::<u32>()) as usize;
    let align = std::mem::align_of::<SID_AND_ATTRIBUTES>();
    let aligned = (after_count + (align - 1)) & !(align - 1);
    let groups_ptr = aligned as *const SID_AND_ATTRIBUTES;
    for i in 0..group_count {
        let entry: SID_AND_ATTRIBUTES = std::ptr::read_unaligned(groups_ptr.add(i));
        if (entry.Attributes & SE_GROUP_LOGON_ID) == SE_GROUP_LOGON_ID {
            let sid = entry.Sid;
            let sid_len = GetLengthSid(sid);
            if sid_len == 0 {
                return None;
            }
            let mut out = vec![0u8; sid_len as usize];
            if CopySid(sid_len, out.as_mut_ptr() as *mut c_void, sid) == 0 {
                return None;
            }
            return Some(out);
        }
    }
    None
}

/// 创建写能力令牌：restricting SIDs = capabilities + logon + everyone。
///
/// # Safety
/// 调用方负责 CloseHandle 返回的令牌；psid_capabilities 必须指向有效 SID 且
/// 生命周期覆盖本次调用。
pub unsafe fn create_write_restricted_token_with_caps(
    psid_capabilities: &[*mut c_void],
) -> Result<HANDLE> {
    let base = get_current_token_for_restriction()?;
    let result = create_write_restricted_token_with_caps_from(base, psid_capabilities);
    CloseHandle(base);
    result
}

// SAFETY: 同上；base_token 为有效主令牌句柄。
unsafe fn create_write_restricted_token_with_caps_from(
    base_token: HANDLE,
    psid_capabilities: &[*mut c_void],
) -> Result<HANDLE> {
    if psid_capabilities.is_empty() {
        return Err(anyhow!("no capability SIDs provided"));
    }
    let mut logon_sid_bytes = get_logon_sid_bytes(base_token)?;
    let psid_logon = logon_sid_bytes.as_mut_ptr() as *mut c_void;
    let mut everyone = world_sid()?;
    let psid_everyone = everyone.as_mut_ptr() as *mut c_void;

    // Exact order: Capabilities..., Logon, Everyone（与 codex 一致）。
    let mut entries: Vec<SID_AND_ATTRIBUTES> =
        vec![std::mem::zeroed(); psid_capabilities.len() + 2];
    for (i, psid) in psid_capabilities.iter().enumerate() {
        entries[i].Sid = *psid;
        entries[i].Attributes = 0;
    }
    let logon_idx = psid_capabilities.len();
    entries[logon_idx].Sid = psid_logon;
    entries[logon_idx].Attributes = 0;
    entries[logon_idx + 1].Sid = psid_everyone;
    entries[logon_idx + 1].Attributes = 0;

    let mut new_token: HANDLE = std::ptr::null_mut();
    let flags = DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED;
    let ok = CreateRestrictedToken(
        base_token,
        flags,
        0,
        std::ptr::null(),
        0,
        std::ptr::null(),
        entries.len() as u32,
        entries.as_mut_ptr(),
        &mut new_token,
    );
    if ok == 0 {
        return Err(anyhow!("CreateRestrictedToken failed: {}", GetLastError()));
    }

    // 默认 DACL 要放行 logon/everyone/能力 SID，否则子进程创建命名/匿名 IPC
    // 对象（例如 PowerShell 管道）会 ACCESS_DENIED。
    let mut dacl_sids: Vec<*mut c_void> = Vec::with_capacity(psid_capabilities.len() + 2);
    dacl_sids.push(psid_logon);
    dacl_sids.push(psid_everyone);
    dacl_sids.extend_from_slice(psid_capabilities);
    set_default_dacl(new_token, &dacl_sids)?;

    enable_single_privilege(new_token, "SeChangeNotifyPrivilege")?;
    Ok(new_token)
}

// SAFETY: h_token 有效。
unsafe fn set_default_dacl(h_token: HANDLE, sids: &[*mut c_void]) -> Result<()> {
    if sids.is_empty() {
        return Ok(());
    }
    let entries: Vec<EXPLICIT_ACCESS_W> = sids
        .iter()
        .map(|sid| EXPLICIT_ACCESS_W {
            grfAccessPermissions: GENERIC_ALL,
            grfAccessMode: GRANT_ACCESS,
            grfInheritance: 0,
            Trustee: TRUSTEE_W {
                pMultipleTrustee: std::ptr::null_mut(),
                MultipleTrusteeOperation: 0,
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_UNKNOWN,
                ptstrName: *sid as *mut u16,
            },
        })
        .collect();
    let mut p_new_dacl: *mut ACL = std::ptr::null_mut();
    let res = SetEntriesInAclW(
        entries.len() as u32,
        entries.as_ptr(),
        std::ptr::null_mut(),
        &mut p_new_dacl,
    );
    if res != ERROR_SUCCESS {
        return Err(anyhow!("SetEntriesInAclW failed: {res}"));
    }
    // TOKEN_DEFAULT_DACL 结构：其 PACL 字段。
    let mut info = [p_new_dacl as usize];
    let ok = SetTokenInformation(
        h_token,
        TokenDefaultDacl,
        info.as_mut_ptr() as *mut c_void,
        std::mem::size_of::<usize>() as u32,
    );
    if !p_new_dacl.is_null() {
        LocalFree(p_new_dacl as HLOCAL);
    }
    if ok == 0 {
        return Err(anyhow!(
            "SetTokenInformation(TokenDefaultDacl) failed: {}",
            GetLastError()
        ));
    }
    Ok(())
}

// SAFETY: h_token 有效。
unsafe fn enable_single_privilege(h_token: HANDLE, name: &str) -> Result<()> {
    let wide = super::spawn::to_wide(name);
    let mut luid = windows_sys::Win32::Foundation::LUID {
        LowPart: 0,
        HighPart: 0,
    };
    let ok = LookupPrivilegeValueW(std::ptr::null(), wide.as_ptr(), &mut luid);
    if ok == 0 {
        return Err(anyhow!("LookupPrivilegeValueW failed: {}", GetLastError()));
    }
    let mut tp: TOKEN_PRIVILEGES = std::mem::zeroed();
    tp.PrivilegeCount = 1;
    tp.Privileges[0].Luid = luid;
    tp.Privileges[0].Attributes = SE_PRIVILEGE_ENABLED;
    let ok2 = AdjustTokenPrivileges(
        h_token,
        0,
        &tp,
        0,
        std::ptr::null_mut(),
        std::ptr::null_mut(),
    );
    if ok2 == 0 {
        return Err(anyhow!("AdjustTokenPrivileges failed: {}", GetLastError()));
    }
    // AdjustTokenPrivileges 返回非 0 不代表所有特权都成功启用，
    // 必须再检查 GetLastError()==ERROR_SUCCESS。
    let err = GetLastError();
    if err != ERROR_SUCCESS {
        return Err(anyhow!("AdjustTokenPrivileges error: {err}"));
    }
    Ok(())
}
