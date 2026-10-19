# 창 제목(일부)으로 창을 찾아 주 모니터로 옮기고 최대화한 뒤 맨 앞으로 올린다. 녹화(record-demo.mjs)용.
# 사용: powershell -NoProfile -ExecutionPolicy Bypass -File tools/winctl.ps1 -Title "유튜브 댓글 에이전트"
# 결과: 찾으면 "ok <제목>", 못 찾으면 "notfound" (종료 코드 1)
param([Parameter(Mandatory = $true)][string]$Title)

Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class JgWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
}
'@

$found = [IntPtr]::Zero
$foundTitle = ''
$cb = [JgWin+EnumProc] {
  param($h, $l)
  if (-not [JgWin]::IsWindowVisible($h)) { return $true }
  $sb = New-Object System.Text.StringBuilder 512
  [void][JgWin]::GetWindowText($h, $sb, 512)
  $t = $sb.ToString()
  if ($t -and $t.Contains($Title)) { $script:found = $h; $script:foundTitle = $t; return $false }
  return $true
}
[void][JgWin]::EnumWindows($cb, [IntPtr]::Zero)
if ($found -eq [IntPtr]::Zero) { 'notfound'; exit 1 }

[void][JgWin]::ShowWindow($found, 9)                                  # 원래 크기로(최소화·최대화 풀기)
[void][JgWin]::SetWindowPos($found, [IntPtr]::Zero, 0, 0, 1280, 800, 0x0040)  # 주 모니터 왼쪽 위로 옮기기
[void][JgWin]::ShowWindow($found, 3)                                  # 최대화
[JgWin]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)                     # Alt 를 눌렀다 떼야 다른 프로그램 창을 앞으로 올릴 수 있다
[JgWin]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
[void][JgWin]::BringWindowToTop($found)
[void][JgWin]::SetForegroundWindow($found)
"ok $foundTitle"
