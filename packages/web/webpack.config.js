const path = require("path");

module.exports = {
  entry: path.join(__dirname, "src", "index.tsx"),
  output: {
    filename: "app.js",
    chunkFilename: "[name].bundle.js",
    path: path.resolve(__dirname, "../server-shared/public/scripts"),
  },
  devtool: "inline-source-map",
  module: {
    rules: [
      {
        test: /\.(ts|tsx)$/,
        exclude: [/node_modules/],
        loader: "ts-loader",
      },
      {
        test: /\.(js|jsx)$/,
        exclude: /node_modules/,
        use: ["babel-loader"],
      },
      {
        test: /\.(css|scss)$/,
        use: ["style-loader", "css-loader"],
      },
      {
        test: /\.(jpg|jpeg|png|gif|mp3|svg)$/,
        use: ["file-loader"],
      },
    ],
  },
  resolve: {
    extensions: [".tsx", ".ts", ".js"],
  },
};
