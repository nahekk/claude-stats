' Creates a "Claude Stats" shortcut on your desktop that starts the dashboard with one click.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)

Set lnk = sh.CreateShortcut(sh.SpecialFolders("Desktop") & "\Claude Stats.lnk")
lnk.TargetPath = sh.ExpandEnvironmentStrings("%WINDIR%") & "\System32\wscript.exe"
lnk.Arguments = """" & dir & "\Claude Stats.vbs"""
lnk.WorkingDirectory = dir
lnk.IconLocation = dir & "\icon.ico,0"
lnk.Description = "Claude Stats - live Claude Code usage dashboard"
lnk.Save

MsgBox "Done! Double-click ""Claude Stats"" on your desktop." & vbCrLf & vbCrLf & _
       "Gotowe! Kliknij dwukrotnie ""Claude Stats"" na pulpicie.", 64, "Claude Stats"
