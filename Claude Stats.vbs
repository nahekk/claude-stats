' Starts Claude Stats without a console window and opens it in the browser.
' The server stops by itself a few seconds after you close the tab.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)

If sh.Run("cmd /c where node", 0, True) <> 0 Then
  MsgBox "Node.js is required. Install it from https://nodejs.org and try again.", 16, "Claude Stats"
  WScript.Quit 1
End If

sh.CurrentDirectory = dir
sh.Run "node """ & dir & "\server.js"" --exit-when-closed", 0, False
