# Keeps Windows from idle-sleeping while a Flow run is in progress (browser automation is not "user input",
# so a 30-minute idle timer puts the PC to sleep mid-render). Process-scoped: the request ends when this
# script exits, no power-plan settings are changed. Started/stopped by src/index.ts.
Add-Type -Namespace KeepAwake -Name Native -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true)]
public static extern uint SetThreadExecutionState(uint esFlags);
'@
$ES_CONTINUOUS = [uint32]0x80000000
$ES_SYSTEM_REQUIRED = [uint32]0x00000001
$ES_DISPLAY_REQUIRED = [uint32]0x00000002
while ($true) {
  [KeepAwake.Native]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED -bor $ES_DISPLAY_REQUIRED) | Out-Null
  Start-Sleep -Seconds 30
}
