use crate::helpers::factories::url::create_classic_link;
use crate::helpers::supertest::request;
use crate::helpers::target::app;
use crate::setup_each_test::test;

mod middlewares_check_url_ownership {
    use super::*;

    #[test]
    fn returns_403_when_an_anonymous_user_does_not_own_the_url() {
        test(async {
            let owner = request::agent(app());
            owner.get("/auth/status").await;
            let link = create_classic_link(&owner, None).await;

            let stranger = request::agent(app());
            stranger.get("/auth/status").await;
            let res = stranger.get(&format!("/qr/{}", link["URLId"])).await;

            assert_eq!(res.status_code, 403);
        });
    }
}
