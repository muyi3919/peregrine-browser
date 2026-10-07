param([Parameter(Mandatory=$true)][string]$ConfigBase64)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$config = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ConfigBase64)) | ConvertFrom-Json

# This helper never changes the title or registry, and never enumerates child
# processes. Only visible Chromium top-level windows belonging to the exact
# browser PID are eligible. Holding the process handle prevents PID reuse.
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

public static class PeregrineNativeWindow {
    [StructLayout(LayoutKind.Sequential)] public struct PropertyKey { public Guid format; public uint id; public PropertyKey(uint value) { format = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"); id = value; } }
    [StructLayout(LayoutKind.Explicit, Size=24)] public struct PropVariant { [FieldOffset(0)] public ushort type; [FieldOffset(8)] public IntPtr text; }
    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface PropertyStore {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int GetAt(uint index, out PropertyKey key);
        [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
        [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant value);
        [PreserveSig] int Commit();
    }
    public delegate bool EnumWindowCallback(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowCallback callback, IntPtr parameter);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int length);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder text, int length);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr LoadImage(IntPtr module, string name, uint type, int width, int height, uint flags);
    [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr icon);
    [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr parameter, IntPtr data, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll", EntryPoint="GetClassLongPtrW")] static extern IntPtr GetClassLongPtr(IntPtr window, int index);
    [DllImport("shell32.dll")] static extern int SHGetPropertyStoreForWindow(IntPtr window, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out PropertyStore store);
    [DllImport("ole32.dll")] static extern int PropVariantClear(ref PropVariant value);
    static readonly Guid StoreId = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
    public static IntPtr SmallIcon = IntPtr.Zero, BigIcon = IntPtr.Zero;
    public static int propertyWrites = 0, iconWrites = 0;

    public class WindowInfo {
        public string handle, title, className, appUserModelId, relaunchDisplayName, relaunchCommand, relaunchIconResource, smallIconHash, bigIconHash;
    }
    public static void LoadIcons(string file) {
        if (String.IsNullOrEmpty(file)) return;
        SmallIcon = LoadImage(IntPtr.Zero, file, 1, 16, 16, 0x10);
        BigIcon = LoadImage(IntPtr.Zero, file, 1, 32, 32, 0x10);
        if (SmallIcon == IntPtr.Zero || BigIcon == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "Unable to load browser icons.");
    }
    public static void ReleaseIcons() { if (SmallIcon != IntPtr.Zero) DestroyIcon(SmallIcon); if (BigIcon != IntPtr.Zero) DestroyIcon(BigIcon); SmallIcon = BigIcon = IntPtr.Zero; }
    static string ReadProperty(PropertyStore store, uint id) {
        PropertyKey key = new PropertyKey(id); PropVariant value;
        Marshal.ThrowExceptionForHR(store.GetValue(ref key, out value));
        try { return value.type == 31 ? Marshal.PtrToStringUni(value.text) : null; } finally { PropVariantClear(ref value); }
    }
    static bool SetProperty(PropertyStore store, uint id, string text) {
        if (ReadProperty(store, id) == text) return false;
        PropertyKey key = new PropertyKey(id);
        PropVariant value = new PropVariant { type=31, text=Marshal.StringToCoTaskMemUni(text) };
        try { Marshal.ThrowExceptionForHR(store.SetValue(ref key, ref value)); propertyWrites++; return true; } finally { PropVariantClear(ref value); }
    }
    static PropertyStore GetStore(IntPtr window) { Guid id=StoreId; PropertyStore store; Marshal.ThrowExceptionForHR(SHGetPropertyStoreForWindow(window, ref id, out store)); return store; }
    static IntPtr Send(IntPtr window, uint message, int parameter, IntPtr data) {
        IntPtr value;
        if (SendMessageTimeout(window, message, new IntPtr(parameter), data, 2, 200, out value) == IntPtr.Zero) {
            int error = Marshal.GetLastWin32Error();
            if (error == 0 || error == 1460) throw new TimeoutException("Browser window is temporarily busy.");
            throw new System.ComponentModel.Win32Exception(error, "Browser window did not respond.");
        }
        return value;
    }
    static IntPtr IconHandle(IntPtr window, bool big) {
        IntPtr result = Send(window, 0x007f, big ? 1 : 0, IntPtr.Zero);
        if (result == IntPtr.Zero && !big) result = Send(window, 0x007f, 2, IntPtr.Zero);
        if (result == IntPtr.Zero) result = GetClassLongPtr(window, big ? -14 : -34);
        return result;
    }
    public static string IconHash(IntPtr handle) {
        if (handle == IntPtr.Zero) return null;
        using (Icon icon = Icon.FromHandle(handle)) using (Bitmap image = icon.ToBitmap()) using (MemoryStream data = new MemoryStream()) using (SHA256 sha = SHA256.Create()) {
            image.Save(data, ImageFormat.Png);
            return BitConverter.ToString(sha.ComputeHash(data.ToArray())).Replace("-", "").ToLowerInvariant();
        }
    }
    static List<IntPtr> Windows(uint processId) {
        List<IntPtr> windows = new List<IntPtr>();
        EnumWindowCallback callback = delegate(IntPtr window, IntPtr unused) {
            uint owner; GetWindowThreadProcessId(window, out owner);
            if (owner != processId || !IsWindowVisible(window) || GetWindow(window, 4) != IntPtr.Zero) return true;
            StringBuilder name = new StringBuilder(256); GetClassName(window, name, name.Capacity);
            if (name.ToString() == "Chrome_WidgetWin_1") windows.Add(window);
            return true;
        };
        EnumWindows(callback, IntPtr.Zero);
        GC.KeepAlive(callback);
        return windows;
    }
    public static void Apply(uint processId, string appId, string productName, string command, string iconFile) {
        foreach (IntPtr window in Windows(processId)) {
          try {
            PropertyStore store = GetStore(window);
            try {
                // Set relaunch properties together before changing grouping identity.
                bool changed = SetProperty(store, 2, command);
                changed = SetProperty(store, 3, iconFile + ",0") || changed;
                changed = SetProperty(store, 4, productName) || changed;
                changed = SetProperty(store, 5, appId) || changed;
                if (changed) Marshal.ThrowExceptionForHR(store.Commit());
            } finally { Marshal.ReleaseComObject(store); }
            if (IconHandle(window, false) != SmallIcon) { Send(window, 0x0080, 0, SmallIcon); iconWrites++; }
            if (IconHandle(window, true) != BigIcon) { Send(window, 0x0080, 1, BigIcon); iconWrites++; }
          } catch (TimeoutException) {
            // Busy native menus/dialogs are temporary. Retry on the next tick;
            // cosmetic updates must not terminate a healthy browser session.
          } catch {
            // A window may close between enumeration and its property/icon call.
            uint owner; GetWindowThreadProcessId(window, out owner);
            if (IsWindow(window) && owner == processId) throw;
          }
        }
    }
    public static WindowInfo[] Inspect(uint processId) {
        List<WindowInfo> result = new List<WindowInfo>();
        foreach (IntPtr window in Windows(processId)) {
            StringBuilder title = new StringBuilder(8192), name = new StringBuilder(256);
            GetWindowText(window, title, title.Capacity); GetClassName(window, name, name.Capacity);
            WindowInfo info = new WindowInfo { handle=window.ToInt64().ToString(), title=title.ToString(), className=name.ToString() };
            PropertyStore store = GetStore(window);
            try { info.appUserModelId=ReadProperty(store, 5); info.relaunchDisplayName=ReadProperty(store, 4); info.relaunchCommand=ReadProperty(store, 2); info.relaunchIconResource=ReadProperty(store, 3); }
            finally { Marshal.ReleaseComObject(store); }
            info.smallIconHash = IconHash(IconHandle(window, false)); info.bigIconHash = IconHash(IconHandle(window, true)); result.Add(info);
        }
        return result.ToArray();
    }
}
'@

$target = [Diagnostics.Process]::GetProcessById([int]$config.processId)
# Resolve and hold an OS handle before inspecting any browser HWND.
$targetHandle = $target.Handle
$targetPath = $target.MainModule.FileName
if ($config.processPath -and ![string]::Equals([IO.Path]::GetFullPath($config.processPath), $targetPath, [StringComparison]::OrdinalIgnoreCase)) { throw 'Browser process path does not match its owner.' }
$started = $target.StartTime.ToUniversalTime().ToString('o')
[PeregrineNativeWindow]::LoadIcons($config.iconPath)
try {
    if ($config.mode -eq 'inspect') {
        @{processId=[uint32]$config.processId; processPath=$targetPath; startTimeUtc=$started; expectedIconHashes=@{small=[PeregrineNativeWindow]::IconHash([PeregrineNativeWindow]::SmallIcon); big=[PeregrineNativeWindow]::IconHash([PeregrineNativeWindow]::BigIcon)}; windows=@([PeregrineNativeWindow]::Inspect([uint32]$config.processId))} | ConvertTo-Json -Depth 6 -Compress
        exit 0
    }
    if ($config.mode -ne 'watch') { throw 'Invalid window branding mode.' }
    $ready = $false
    while (!$target.HasExited) {
        [PeregrineNativeWindow]::Apply([uint32]$config.processId, $config.appUserModelId, $config.productName, $config.relaunchCommand, $config.iconPath)
        if (!$ready) {
            $windows = @([PeregrineNativeWindow]::Inspect([uint32]$config.processId))
            if ($windows.Count -gt 0) {
                @{event='ready'; processId=[uint32]$config.processId; windows=$windows; propertyWrites=[PeregrineNativeWindow]::propertyWrites; iconWrites=[PeregrineNativeWindow]::iconWrites} | ConvertTo-Json -Depth 6 -Compress
                $ready = $true
            }
        }
        Start-Sleep -Milliseconds $(if ($ready) { 1000 } else { 100 })
        $target.Refresh()
    }
} finally { [PeregrineNativeWindow]::ReleaseIcons(); $target.Dispose() }
