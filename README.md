# ✍️ TRACE

TRACE is a Visual Studio Code extension that features automatic code edit recommendations.

# 📑 Content 
- [Demo](#-demo)
- [UI](#-ui)
- [Usage](#-usage)
- [Deployment](#-deployment)
- [Issues](#-issues)

## 🚀 Demo
> [!NOTE]
> Please click the image to watch the demo video on YouTube.

<div align="center">
   <a href="https://youtu.be/qfftiPzf5b4">
   <img src="./extension/assets/video_cover.png" width="600" />
   </a>
</div>

## ✨ UI

### Overview

### Diff View

## 🧑‍💻 Usage

## 🕹️ Deployments

### Deploy as a user

### Deploy as a developer
For debugging, customization purposes, please follow the instructions

1. Under directory `./extension`, install Node packages:
    ```bash
    npm install
    ```
3. Open the project directory in VS Code, press `F5`, choose `Run Extension` if you are required to choose a configuration;
4. A new VS Code window (the "development host") will open with CoEdPilot extension loaded;
5. You may debug or customize the extension via the development host;
6. To pack your customized extension, make sure `yarn` is installed:
    ```bash
    npm install -g yarn
    npm install -g vsce
    ```
7. Under the project root directory:
    ```bash
    yarn package
    ```
    The command will generate a `.vsix` file under `./extension`, based on `package.json` file.
8. For public usage, you may release it to VS Code extension market
    > - Please follow the [VS Code Extension Marketplace guidelines](https://code.visualstudio.com/api/working-with-extensions/publishing-extension);
	> - If you modify and redistribute this extension, please clearly indicate that your version is a fork or modification, and **credit this project as the original**.
9. For personal usage, you may open the VS Code command palette (`Ctrl` + `Shift` + `P` / `Cmd` + `Shift` + `P`), then select `Extensions: Install from VSIX...` and choose the `.vsix` file generated in the previous step.

## ❓ Issues

The project is still in development, not fully tested on different platforms. 

Welcome to propose issues or contribute to the code.

**😄 Enjoy coding!**
