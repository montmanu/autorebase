"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const github_rebase_1 = require("github-rebase");
const git_1 = require("shared-github-internals/lib/git");
const utils_1 = require("./utils");
const merge = async ({ head, octokit, owner, pullRequestNumber, repo, }) => {
    utils_1.debug("merging", pullRequestNumber);
    await octokit.pullRequests.merge({
        merge_method: "rebase",
        number: pullRequestNumber,
        owner,
        repo,
    });
    utils_1.debug("merged", pullRequestNumber);
    utils_1.debug("deleting reference", head);
    await git_1.deleteReference({ octokit, owner, ref: head, repo });
    utils_1.debug("reference deleted", head);
    return {
        pullRequestNumber,
        type: "merge",
    };
};
const rebase = async ({ label, octokit, owner, pullRequestNumber, repo, }) => {
    utils_1.debug("rebasing", pullRequestNumber);
    try {
        const rebased = await utils_1.withLabelLock({
            async action() {
                await github_rebase_1.default({
                    octokit,
                    owner,
                    pullRequestNumber,
                    repo,
                });
            },
            label,
            octokit,
            owner,
            pullRequestNumber,
            repo,
        });
        if (!rebased) {
            utils_1.debug("other process already rebasing, aborting", pullRequestNumber);
            return { pullRequestNumber, type: "abort" };
        }
        utils_1.debug("rebased", pullRequestNumber);
        return { pullRequestNumber, type: "rebase" };
    }
    catch (error) {
        const message = "rebase failed";
        utils_1.debug(message, error);
        await octokit.issues.createComment({
            body: [`The rebase failed:`, "", "```", error.message, "```"].join("\n"),
            number: pullRequestNumber,
            owner,
            repo,
        });
        throw new Error(message);
    }
};
const findAndRebasePullRequestOnSameBase = async ({ base, label, octokit, owner, repo, }) => {
    utils_1.debug("searching for pull request to rebase on same base", base);
    const pullRequest = await utils_1.findOldestPullRequest({
        extraSearchQualifiers: `base:${base}`,
        label,
        octokit,
        owner,
        predicate: ({ mergeableState }) => mergeableState === "behind",
        repo,
    });
    utils_1.debug("pull request to rebase on same base", pullRequest);
    return pullRequest
        ? rebase({
            label,
            octokit,
            owner,
            pullRequestNumber: pullRequest.pullRequestNumber,
            repo,
        })
        : { type: "nop" };
};
const autorebasePullRequest = async ({ label, octokit, owner, pullRequest, repo, }) => {
    utils_1.debug("autorebasing pull request", { pullRequest });
    const shouldBeAutosquashed = await github_rebase_1.needAutosquashing({
        octokit,
        owner,
        pullRequestNumber: pullRequest.pullRequestNumber,
        repo,
    });
    utils_1.debug("should be autosquashed", {
        pullRequestNumber: pullRequest.pullRequestNumber,
        shouldBeAutosquashed,
    });
    const shouldBeRebased = shouldBeAutosquashed || pullRequest.mergeableState === "behind";
    if (shouldBeRebased) {
        return rebase({
            label,
            octokit,
            owner,
            pullRequestNumber: pullRequest.pullRequestNumber,
            repo,
        });
    }
    if (pullRequest.mergeableState === "clean") {
        return merge({
            head: pullRequest.head,
            octokit,
            owner,
            pullRequestNumber: pullRequest.pullRequestNumber,
            repo,
        });
    }
    return { type: "nop" };
};
const autorebase = async ({ 
// Should only be used in tests.
_intercept = () => Promise.resolve(), event, octokit, options, owner, repo, }) => {
    const { label } = options;
    utils_1.debug("starting", { label, name: event.name });
    if (event.name === "status") {
        const pullRequest = await utils_1.findAutorebaseablePullRequestMatchingSha({
            label,
            octokit,
            owner,
            repo,
            sha: event.payload.sha,
        });
        if (pullRequest) {
            utils_1.debug("autorebaseable pull request matching status", pullRequest);
            if (pullRequest.mergeableState === "clean") {
                return merge({
                    head: pullRequest.head,
                    octokit,
                    owner,
                    pullRequestNumber: pullRequest.pullRequestNumber,
                    repo,
                });
            }
            else if (pullRequest.mergeableState === "blocked") {
                // Happens when an autorebaseable pull request gets blocked by an error status.
                // Assuming that the autorebase label was added on a pull request behind but with green statuses,
                // it means that the act of rebasing the pull request made it unmergeable.
                // Some manual intervention will have to be done on the pull request to unblock it.
                // In the meantime, in order not to be stuck,
                // Autorebase will try to rebase another pull request based on the same branch.
                return findAndRebasePullRequestOnSameBase({
                    base: pullRequest.base,
                    label,
                    octokit,
                    owner,
                    repo,
                });
            }
        }
    }
    else {
        const pullRequest = await utils_1.getPullRequestInfoWithKnownMergeableState({
            label,
            octokit,
            owner,
            pullRequest: event.payload.pull_request,
            repo,
        });
        utils_1.debug("pull request from payload", pullRequest);
        if (event.name === "pull_request") {
            if (pullRequest.labeledAndOpenedAndRebaseable &&
                (event.payload.action === "opened" ||
                    event.payload.action === "synchronize" ||
                    (event.payload.action === "labeled" &&
                        event.payload.label.name === options.label))) {
                await _intercept();
                return autorebasePullRequest({
                    label,
                    octokit,
                    owner,
                    pullRequest,
                    repo,
                });
            }
            else if (event.payload.action === "closed" && pullRequest.merged) {
                return findAndRebasePullRequestOnSameBase({
                    base: pullRequest.base,
                    label,
                    octokit,
                    owner,
                    repo,
                });
            }
        }
        else if (pullRequest.labeledAndOpenedAndRebaseable &&
            event.name === "pull_request_review" &&
            event.payload.action === "submitted" &&
            pullRequest.mergeableState === "clean") {
            return merge({
                head: pullRequest.head,
                octokit,
                owner,
                pullRequestNumber: pullRequest.pullRequestNumber,
                repo,
            });
        }
    }
    return { type: "nop" };
};
exports.default = autorebase;
