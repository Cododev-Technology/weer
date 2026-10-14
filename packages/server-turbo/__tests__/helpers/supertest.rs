// What supertest is to the Node.js version, made with reqwest (the fetch() of this app). Like
// supertest, it doesn't follow redirects, it takes compressed responses, and an agent keeps
// the cookies that the server sets (like a browser does).

use std::cell::RefCell;
use std::future::{Future, IntoFuture};
use std::pin::Pin;
use std::rc::Rc;
use std::sync::LazyLock;
use std::time::Duration;

use cpeak::Value;
use reqwest::{Client, ClientBuilder, Method, redirect};

// Every request gets a connection of its own, like with supertest
fn client() -> ClientBuilder {
    Client::builder()
        .redirect(redirect::Policy::none())
        .pool_max_idle_per_host(0)
        .timeout(Duration::from_secs(60))
}

// Asks for compressed responses, and unzips them
static CLIENT: LazyLock<Client> = LazyLock::new(|| client().build().unwrap());

// For a request that sets the Accept-Encoding header itself: the response is left the way the
// server sent it. (reqwest takes the Content-Encoding header off a response that it unzips.)
static AS_IT_IS: LazyLock<Client> = LazyLock::new(|| client().no_gzip().build().unwrap());

// The cookies of an agent (name, value)
type Jar = Rc<RefCell<Vec<(String, String)>>>;

#[derive(Clone)]
pub struct Agent {
    // The address of the server, like http://127.0.0.1:2080
    app: String,
    // None for a plain request(app), which doesn't keep any cookies
    jar: Option<Jar>,
}

// request(app): for requests that don't share any cookies
pub fn request(app: &str) -> Agent {
    Agent {
        app: app.to_string(),
        jar: None,
    }
}

pub mod request {
    use std::cell::RefCell;
    use std::rc::Rc;

    // request.agent(app): every request of an agent sends the cookies that the ones before it got
    pub fn agent(app: &str) -> super::Agent {
        super::Agent {
            jar: Some(Rc::new(RefCell::new(Vec::new()))),
            ..super::request(app)
        }
    }
}

impl Agent {
    pub fn get(&self, path: &str) -> Test {
        self.test(Method::GET, path)
    }

    pub fn post(&self, path: &str) -> Test {
        self.test(Method::POST, path)
    }

    pub fn patch(&self, path: &str) -> Test {
        self.test(Method::PATCH, path)
    }

    pub fn delete(&self, path: &str) -> Test {
        self.test(Method::DELETE, path)
    }

    // agent.jar.setCookie(`${name}=${value}`)
    pub fn set_cookie(&self, name: &str, value: &str) {
        if let Some(jar) = &self.jar {
            let mut jar = jar.borrow_mut();
            jar.retain(|(cookie, _)| cookie != name);
            jar.push((name.to_string(), value.to_string()));
        }
    }

    fn test(&self, method: Method, path: &str) -> Test {
        Test {
            agent: self.clone(),
            method,
            path: path.to_string(),
            headers: Vec::new(),
        }
    }
}

// A request that is being put together. Awaiting it sends it, like in JavaScript.
pub struct Test {
    agent: Agent,
    method: Method,
    path: String,
    headers: Vec<(String, String)>,
}

pub enum Body {
    Json(Value),
    Text(String),
}

impl From<Value> for Body {
    fn from(body: Value) -> Self {
        Body::Json(body)
    }
}

impl From<&str> for Body {
    fn from(body: &str) -> Self {
        Body::Text(body.to_string())
    }
}

impl Test {
    // .set(name, value): add a header to the request
    pub fn set(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.to_string(), value.to_string()));
        self
    }

    // .send(body): send the request with a body. A json!() value goes as JSON, a string as it is.
    pub async fn send(mut self, body: impl Into<Body>) -> Response {
        let body = match body.into() {
            Body::Json(body) => {
                if !self.has_header("content-type") {
                    self = self.set("Content-Type", "application/json");
                }
                body.to_string()
            }
            Body::Text(body) => body,
        };
        self.run(Some(body)).await
    }

    fn has_header(&self, name: &str) -> bool {
        self.headers
            .iter()
            .any(|(header, _)| header.eq_ignore_ascii_case(name))
    }

    async fn run(mut self, body: Option<String>) -> Response {
        if !self.has_header("cookie")
            && let Some(jar) = &self.agent.jar
        {
            let cookies: Vec<String> = jar
                .borrow()
                .iter()
                .map(|(name, value)| format!("{name}={value}"))
                .collect();
            if !cookies.is_empty() {
                self = self.set("Cookie", &cookies.join("; "));
            }
        }

        let client = if self.has_header("accept-encoding") {
            &AS_IT_IS
        } else {
            &CLIENT
        };

        let url = format!("{}{}", self.agent.app, self.path);
        let mut request = client.request(self.method.clone(), &url);
        for (name, value) in &self.headers {
            request = request.header(name, value);
        }
        if let Some(body) = body {
            request = request.body(body);
        }

        let res = request
            .send()
            .await
            .unwrap_or_else(|error| panic!("{} {url} failed: {error:?}", self.method));

        let status_code = res.status().as_u16();
        let headers: Vec<(String, String)> = res
            .headers()
            .iter()
            .map(|(name, value)| {
                (
                    name.to_string(),
                    String::from_utf8_lossy(value.as_bytes()).into_owned(),
                )
            })
            .collect();
        let bytes = res
            .bytes()
            .await
            .unwrap_or_else(|error| panic!("{} {url} failed: {error:?}", self.method))
            .to_vec();

        let res = Response::new(status_code, headers, bytes);

        // Keep the cookies that the server set, and drop the ones it cleared
        if let Some(jar) = &self.agent.jar {
            let mut jar = jar.borrow_mut();
            for cookie in &res.set_cookie {
                let mut parts = cookie.split(';').map(str::trim);
                let Some((name, value)) = parts.next().and_then(|pair| pair.split_once('=')) else {
                    continue;
                };
                jar.retain(|(existing, _)| existing != name);
                let cleared = parts.any(|part| part.eq_ignore_ascii_case("max-age=0"));
                if !cleared {
                    jar.push((name.to_string(), value.to_string()));
                }
            }
        }

        res
    }
}

// `await request(app).get(path)`: awaiting a request sends it without a body
impl IntoFuture for Test {
    type Output = Response;
    type IntoFuture = Pin<Box<dyn Future<Output = Response>>>;

    fn into_future(self) -> Self::IntoFuture {
        Box::pin(self.run(None))
    }
}

pub struct Response {
    pub status_code: u16,
    // The headers, with their names in lower case
    pub headers: Vec<(String, String)>,
    // res.headers["set-cookie"]: every Set-Cookie header of the response
    pub set_cookie: Vec<String>,
    // The body as it is (decompressed), as text, and as JSON if that's what it is
    pub bytes: Vec<u8>,
    pub text: String,
    pub body: Value,
}

impl Response {
    fn new(status_code: u16, headers: Vec<(String, String)>, bytes: Vec<u8>) -> Self {
        let mut res = Response {
            status_code,
            set_cookie: headers
                .iter()
                .filter(|(name, _)| name == "set-cookie")
                .map(|(_, value)| value.clone())
                .collect(),
            headers,
            text: String::from_utf8_lossy(&bytes).into_owned(),
            bytes,
            body: Value::Null,
        };

        if res
            .header("content-type")
            .is_some_and(|value| value.contains("json"))
        {
            res.body = res.text.parse().unwrap_or(Value::Null);
        }

        res
    }

    // res.headers[name]
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(header, _)| header == name)
            .map(|(_, value)| value.as_str())
    }
}
