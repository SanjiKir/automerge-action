const process = require("process");

const { ClientError, logger } = require("./common");
const { update } = require("./update");
const { merge } = require("./merge");
const { getOwnerAndRepo } = require("./helpers");

const URL_REGEXP = /^https:\/\/github.com\/([^/]+)\/([^/]+)\/(pull|tree)\/([^ ]+)$/;

const RELEVANT_ACTIONS = [
  "labeled",
  "unlabeled",
  "synchronize",
  "opened",
  "edited",
  "ready_for_review",
  "reopened",
  "unlocked"
];

const PROJECT_CARD_CONTENT_URL_LENGTH = 8;

// we'll only update a few PRs at once:
const MAX_PR_COUNT = 10;

async function executeLocally(context, url) {
  const { octokit } = context;

  const m = url.match(URL_REGEXP);
  if (m && m[3] === "pull") {
    logger.debug("Getting PR data...");
    const { data: pull_request } = await octokit.pulls.get({
      owner: m[1],
      repo: m[2],
      pull_number: m[4]
    });

    const event = {
      action: "opened",
      pull_request
    };

    await executeGitHubAction(context, "pull_request", event);
  } else if (m && m[3] === "tree") {
    const event = {
      ref: `refs/heads/${m[4]}`,
      repository: {
        name: m[2],
        owner: {
          name: m[1]
        }
      }
    };

    await executeGitHubAction(context, "push", event);
  } else {
    throw new ClientError(`invalid URL: ${url}`);
  }
}

async function executeGitHubAction(context, eventName, eventData) {
  logger.info("Event name:", eventName);
  logger.trace("Event data:", eventData);

  if (eventName === "push") {
    await handleBranchUpdate(context, eventName, eventData);
  } else if (eventName === "status") {
    await handleStatusUpdate(context, eventName, eventData);
  } else if (eventName === "pull_request") {
    await handlePullRequestUpdate(context, eventName, eventData);
  } else if (eventName === "check_suite" || eventName === "check_run") {
    await handleCheckUpdate(context, eventName, eventData);
  } else if (eventName === "pull_request_review") {
    await handlePullRequestReviewUpdate(context, eventName, eventData);
  } else if (eventName === "schedule") {
    await handleScheduleTrigger(context);
  } else if (eventName === "issue_comment") {
    await handleIssueComment(context, eventName, eventData);
  } else {
    throw new ClientError(`invalid event type: ${eventName}`);
  }
}

async function handlePullRequestUpdate(context, eventName, event) {
  const { action } = event;
  if (!RELEVANT_ACTIONS.includes(action)) {
    logger.info("Action ignored:", eventName, action);
    return;
  }

  await update(context, event.pull_request);
  const reviews = await getReviewsOrEmptyArray(context, event.pull_request.number);
  await merge(context, event.pull_request, reviews);
}

async function handleCheckUpdate(context, eventName, event) {
  const { action } = event;
  if (action !== "completed") {
    logger.info("A status check is not yet complete:", eventName);
  } else {
    const payload =
      eventName === "check_suite" ? event.check_suite : event.check_run;
    if (payload.conclusion === "success") {
      logger.info("Status check completed successfully");
      const checkPullRequest = payload.pull_requests[0];
      if (checkPullRequest != null) {
        const { octokit } = context;
        const { data: pullRequest } = await octokit.request(
          checkPullRequest.url
        );
        logger.trace("PR:", pullRequest);

        await update(context, pullRequest);
        const reviews = await getReviewsOrEmptyArray(context, pullRequest.number);
        await merge(context, pullRequest, reviews);
      } else {
        const branchName = payload.head_branch;
        if (branchName != null) {
          await checkPullRequestsForBranches(context, event, branchName);
        } else {
          logger.info("Could not find branch name in this status check result");
        }
      }
    } else {
      logger.info("A status check completed unsuccessfully:", eventName);
    }
  }
}

async function handlePullRequestReviewUpdate(context, eventName, event) {
  const { action, review } = event;
  if (action === "submitted") {
    if (review.state === "approved") {
      await update(context, event.pull_request);
      const reviews = await getReviewsOrEmptyArray(context, event.pull_request.number);
      await merge(context, event.pull_request, reviews);
    } else {
      logger.info("Review state is not approved:", review.state);
      logger.info("Action ignored:", eventName, action);
    }
  } else {
    logger.info("Action ignored:", eventName, action);
  }
}

async function handleStatusUpdate(context, eventName, event) {
  const { state, branches } = event;
  if (state !== "success") {
    logger.info("Event state ignored:", eventName, state);
    return;
  }

  if (!branches || branches.length === 0) {
    logger.info("No branches have been referenced:", eventName);
    return;
  }

  for (const branch of branches) {
    await checkPullRequestsForBranches(context, event, branch.name);
  }
}

async function checkPullRequestsForBranches(context, event, branchName) {
  const { octokit } = context;
  logger.debug("Listing pull requests for", branchName, "...");
  const { data: pullRequests } = await octokit.pulls.list({
    owner: event.repository.owner.login,
    repo: event.repository.name,
    state: "open",
    head: `${event.repository.owner.login}:${branchName}`,
    sort: "updated",
    direction: "desc",
    per_page: MAX_PR_COUNT
  });

  logger.trace("PR list:", pullRequests);

  let updated = 0;
  for (const pullRequest of pullRequests) {
    try {
      await update(context, pullRequest);
      const reviews = await getReviewsOrEmptyArray(context, pullRequest.number);
      await merge(context, pullRequest, reviews);
      ++updated;
    } catch (e) {
      logger.error(e);
    }
  }

  if (updated === 0) {
    logger.info("No PRs have been updated/merged");
  }
}

async function handleBranchUpdate(context, eventName, event) {
  const { ref } = event;
  if (!ref.startsWith("refs/heads/")) {
    logger.info("Push does not reference a branch:", ref);
    return;
  }

  const branch = ref.substr(11);
  logger.debug("Updated branch:", branch);

  const { octokit } = context;

  logger.debug("Listing pull requests...");
  const { data: pullRequests } = await octokit.pulls.list({
    owner: event.repository.owner.login,
    repo: event.repository.name,
    state: "open",
    base: branch,
    sort: "updated",
    direction: "desc",
    per_page: MAX_PR_COUNT
  });

  logger.trace("PR list:", pullRequests);

  if (pullRequests.length > 0) {
    logger.info("Open PRs:", pullRequests.length);
  } else {
    logger.info("No open PRs for", branch);
    return;
  }

  let updated = 0;

  for (const pullRequest of pullRequests) {
    try {
      await update(context, pullRequest);
      updated++;
    } catch (e) {
      logger.error(e);
    }
  }

  if (updated > 0) {
    logger.info(updated, "PRs based on", branch, "have been updated");
  } else {
    logger.info("No PRs based on", branch, "have been updated");
  }
}

function reduceProjectCards(acc, card) {
  logger.info('Check for mews-js project card:');
  logger.info(card);
  logger.info(`Card content url is ${card.content_url}`);

  if (!card.content_url) {
    // Handling weird case when automerge fails and can't find content_url. Logger above is for debugging
    return acc;
  }

  const splittedUrl = card.content_url.split('/');

  if (splittedUrl.length !== PROJECT_CARD_CONTENT_URL_LENGTH) {
    throw Error('Unexpected URL format');
  }

  const pullRequestRepo = splittedUrl[splittedUrl.length - 3];
  const { repo } = getOwnerAndRepo();

  if (repo.toLowerCase() !== pullRequestRepo.toLowerCase()) {
    logger.info(`${pullRequestRepo} repo is not part of ${repo} repo. skipping this PR.`);
    return acc;
  }

  const pullRequestNumber = splittedUrl.pop();
  logger.info(`Found pull request #${pullRequestNumber}.`);
  acc.push(pullRequestNumber);
  return acc;
}

async function handleScheduleTrigger(context) {
  const { octokit, config: { projectColumnNumber /*, projectTestingColumnNumber */ } } = context; 
  if (typeof projectColumnNumber === 'undefined') {
    throw new Error('Project column number is undefined. Skipping scheduled job.');
  }

  logger.debug(`Listing issues in column ${projectColumnNumber} ...`);
  const { data: cards } = await octokit.projects.listCards({
    column_id: projectColumnNumber,
  });

  // logger.debug(`Listing issues in testing column number: ${projectTestingColumnNumber} ...`);
  // const { data: testingCards } = await octokit.projects.listCards({
  //   column_id: projectTestingColumnNumber,
  // });

  if (cards.length === 0) {
    logger.info(`Ready to merge column ${projectColumnNumber} doesn't have any issues. Cancelling automerge job.`);
    return;
  }

  const pullRequestToMergeNumbers = cards.reduce(reduceProjectCards, []);
  // Commented lines are disabled since we don't want to merge master now 
  // const pullRequestTestingNumbers = testingCards.reduce(reduceProjectCards, []);

  const pullRequestsToMerge = [];
  for (const pullRequestNumber of pullRequestToMergeNumbers) {
    const pr = await fetchPullRequest(context, pullRequestNumber);
    pullRequestsToMerge.push(pr);
  }

  // const pullRequestsTesting = [];
  // for (const pullRequestNumber of pullRequestTestingNumbers) {
  //   const pr = await fetchPullRequest(context, pullRequestNumber);
  //   pullRequestsTesting.push(pr);
  // }

  // const pullRequestsToUpdate = [...pullRequestsTesting, ...pullRequestsToMerge];

  logger.trace("PR ready to merge list:", pullRequestsToMerge);
  // logger.trace("PR testing list:", pullRequestsTesting);

  let updated = 0;
  // for (const pullRequest of pullRequestsToUpdate) {
  //   try {
  //     await update(context, pullRequest);
  //     ++updated;
  //   } catch (e) {
  //     logger.error(e);
  //   }
  // }

  for (const pullRequest of pullRequestsToMerge) {
    try {
      const reviews = await getReviewsOrEmptyArray(context, pullRequest.number);
      await merge(context, pullRequest, reviews);
      ++updated;
    } catch (e) {
      logger.error(e);
    }
  }

  if (updated === 0) {
    logger.info("No PRs have been updated/merged");
    return;
  }
}

async function handleIssueComment(context, eventName, event) {
  const { action, issue, repository } = event;
  if (action === "created") {
    if (issue.pull_request == null) {
      logger.info("Comment not on a PR, skipping");
    } else {
      const { octokit } = context;

      logger.debug("Getting pull request info for", issue.number, "...");
      let { data: pullRequest } = await octokit.pulls.get({
        owner: repository.owner.login,
        repo: repository.name,
        pull_number: issue.number
      });

      logger.trace("Full PR:", pullRequest);

      await update(context, pullRequest);
      const reviews = await getReviewsOrEmptyArray(context, pullRequest.number);
      await merge(context, pullRequest, reviews);
    }
  } else {
    logger.info("Action ignored:", eventName, action);
  }
}

async function getReviewsOrEmptyArray(context, pullRequestNumber) {
  const { config: { mergeAproovedByReviewers } } = context;
  if (mergeAproovedByReviewers.length <= 0) {
    return [];
  }

  const result =  await fetchPullRequestReviews(context, pullRequestNumber);
  return result.data;
}

async function fetchPullRequest(context, pullRequestNumber) {
  const { octokit } = context;

  const { owner, repo } = getOwnerAndRepo();

  logger.debug("Getting pull request info for", pullRequestNumber, "...");
  let { data: pullRequest } = await octokit.pulls.get({
    owner,
    repo,
    pull_number: pullRequestNumber
  });

  logger.trace("Full PR:", pullRequest);
  return pullRequest;
}

async function fetchPullRequestReviews({ octokit }, pullRequestNumber) {
  const { owner, repo } = getOwnerAndRepo();

  return await octokit.pulls.listReviews({
    owner,
    repo,
    pull_number: pullRequestNumber,
  });
}

module.exports = { executeLocally, executeGitHubAction };
