import app from "./app.js";
import { log } from "cpeak";
import keys from "./config/keys.js";

const port = Number(process.env.PORT || 2080);

const server = app.listen(port, () => {
  log(
    "Starting the server..." +
      "\n----------------------------------\n" +
      "Server has started on port " +
      port +
      "\n----------------------------------"
  );
  console.log("Server is on port " + port);
});

export { server };
