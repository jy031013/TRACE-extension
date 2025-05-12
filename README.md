# ✍️ TRACE

TRACE is a Visual Studio Code extension that features automatic code edit recommendations.

## 🚀 UI Demo
> [!NOTE]
> Please click the image to watch the demo video on YouTube.

<div align="center">
   <a href="https://youtu.be/qfftiPzf5b4">
   <img src="./extension/assets/video_cover.png" width="600" />
   </a>
</div>

## 🧑‍💻 Usage

1. Edit the code, as our extension will automatically record most previous edits.

2. To `Predict Locations`: 
    - **Right-click** anywhere in the editor and select it in the menu;
    - Or use the default keybinding `Ctrl` + `Alt` + `L` (in MacOS `Cmd` + `Alt` + `L`);
    - Or click the short-cut button on top-right corner.

3. Click the **suggested location** on the left location tree-view sidebar will automatically generate corresponding edit solutions.

4. To `Generate Edits` on other locations, select the code to be edited in the editor, then:
    - **Right-click** and select it in the menu;
    - Or use the default keybinding `Ctrl` + `Alt` + `E` (in MacOS `Cmd` + `Alt` + `E`);
    - Or click the short-cut button on top-right corner.

> [!NOTE]
> To select code for editing, you can:
>   * Click recommended locations in the left location list;
>   * Or select part of the code for **replacing**;
>   * Or select nothing to generate **insertion** code at the cursor position.
>
> And by default accepting an edit will trigger another location prediction immediately (you can change this in extension configuration).

5. Manually `Change Edit Description`: **right-click** and select it in the menu. By default the input box will automatically show at query **whenever the edit description is empty**.


6. After the model generates possible edits at that range, a difference tab with pop up for you to switch to different edits or edit the code. **There are buttons on the top right corner of the difference tab to accept, dismiss or switch among generated edits**.

## 🕹️ Deployments

### Deploy as a user

For end-users, simply follow the instructions:
1. install the extension from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=CodePhilia.code-trace).

2. Download the backend models via command:

    ```bash
    python downloads.py
    ```

3. Set up the environment:

    ```bash
    pip install -r requirements.txt
    ```

    * If you are using `conda`, please make sure to activate the environment before running the command.


4. Start backend models via command:

    ```bash
    python backend/server.py
    ```

    * The default port set at [`backend/server.ini`](backend/server.ini) is `5004`

    * If you want to change the port, remember to update the extension configuration as well.

5. If seeing the following message, you are all set to go:
    ![image](extension/assets/ready.png)

### Deploy as a developer

For debugging, customization purposes, please follow the instructions

1. Under directory `./extension`, install Node packages:
    
    ```bash
    npm install
    ```

2. Open the project directory in VS Code, press `F5`, choose `Run Extension` if you are required to choose a configuration;

3. A new VS Code window (the "development host") will open with CoEdPilot extension loaded;

4. You may debug or customize the extension via the development host;

5. To pack your customized extension, make sure `yarn` is installed:

    ```bash
    npm install -g yarn
    npm install -g vsce
    ```

6. Under the project root directory:
    
    ```bash
    yarn package
    ```
    
    The command will generate a `.vsix` file under `./extension`, based on `package.json` file.

7. For public usage, you may release it to VS Code extension market
    
    > - Please follow the [VS Code Extension Marketplace guidelines](https://code.visualstudio.com/api/working-with-extensions/publishing-extension);
	> - If you modify and redistribute this extension, please clearly indicate that your version is a fork or modification, and **credit this project as the original**.

8. For personal usage, you may open the VS Code command palette (`Ctrl` + `Shift` + `P` / `Cmd` + `Shift` + `P`), then select `Extensions: Install from VSIX...` and choose the `.vsix` file generated in the previous step.

## ❓ Issues

The project is still in development, not fully tested on different platforms. 

Welcome to propose issues or contribute to the code.

**😄 Enjoy coding!**
