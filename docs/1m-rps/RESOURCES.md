# Scaling to 1 Million HTTP Requests/s, with Real Business Logic!

This document contains all the resources referenced in the 1 Million RPS with Real Business Logic video.

## CPU Utilization, Threads & AutoCannon:

CPU Utilization Sample Code: https://github.com/Cododev-Technology/weer/raw/1m-rps/docs/1m-rps/cpu-threads.zip

AutoCannon Documentation: https://www.npmjs.com/package/autocannon

Sample HTTP Server in Node.js:

```javascript
const http = require("http");

const PORT = 6000;

const server = http.createServer((req, res) => {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");

  res.end(
    JSON.stringify({
      message: "Hey there!",
    })
  );
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}/`);
});
```

## Introduction to Our Infrastructure:

The Weer Project: https://github.com/Cododev-Technology/weer/tree/1m-rps

## Taking the Hardware for a Test Drive:

Toy URL Shortener Project: https://github.com/agile8118/url-shortener

## Moving to Our Production App:

Free Redis Streaming Course: https://university.redis.io/learningpath/grnomm8jaglgcu?tab=details

## More:

DevOps Engineering Course: https://cododev.ca/udcc

Node.js & Backend Engineering Course: https://cododev.ca/uncc

Focus Timer Application: https://weer.pro/a/focus
