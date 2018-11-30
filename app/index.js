"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const autorebase_1 = require("./autorebase");
module.exports = (app) => {
    app.log("App loaded");
    app.on("*", async (context) => {
        const { owner, repo } = context.repo();
        const action = await autorebase_1.default({
            // @ts-ignore The event is of the good type because Autorebase only subscribes to a subset of webhooks.
            event: { name: context.name, payload: context.payload },
            // @ts-ignore The value is the good one even if the type doesn't match.
            octokit: context.github,
            options: { label: "autorebase" },
            owner,
            repo,
        });
        context.log(action);
    });
};
