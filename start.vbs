Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' Get project directory
strDir = fso.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = strDir

' Launch NodeGUI Native Desktop Terminal directly (Zero HTTP port, pure desktop app)
WshShell.Run "node ./node_modules/@nodegui/nodegui/scripts/qode.js ./nodegui/main.js", 0, False
