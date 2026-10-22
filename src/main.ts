import "./styles.css";
import { App } from "./app";
import { createPlatform } from "./platform";

const platform = await createPlatform();
const app = new App(platform);
await app.start();
(window as any).unacro = app; // handy for debugging from devtools
