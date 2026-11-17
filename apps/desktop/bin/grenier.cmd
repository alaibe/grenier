@echo off
rem The grenier command on Windows, in the app's grenier\bin: the app's Node runs the app's CLI.
"%~dp0..\..\grenier-node.exe" "%~dp0..\dist\grenier.js" %*
