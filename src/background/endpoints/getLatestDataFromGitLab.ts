import * as async from 'async';
import { browser } from 'webextension-polyfill-ts';
import { Gitlab } from '@gitbeaker/browser';
import { getSettings } from '../utils/getSettings';
import { fetchMRExtraInfo } from '../utils/fetchMRExtraInfo';
import { MergeRequests, GetSettingsResponse, MergeRequestsDetails, Todo, GitlabAPI, Issue } from '../types';
import { setBadge } from '../utils/setBadge';
import {
    FailFetchIssues,
    FailFetchMergeRequestsAssigned,
    FailFetchMergeRequestsGiven,
    FailFetchSettings,
    FailFetchTodos,
    GitLabAddressNotSet,
    GitLabTokenNotSet
} from '../errors';

export const getLatestDataFromGitLab = (cb: CallbackErrorOnly) => {
    interface ReviewRequests {
        mrAssigned: MergeRequestsDetails[];
        mrToReview: number;
    }

    interface ReviewGiven {
        mrGiven: MergeRequestsDetails[];
        mrReviewed: number;
    }

    interface AsyncResults {
        getSettings: GetSettingsResponse;
        gitlabApi: GitlabAPI;
        reviewRequests: ReviewRequests;
        givenRequests: ReviewGiven;
        issuesAssigned: Issue[];
        todos: Todo[];
        updateBadge: void;
        saveLocalStorage: void;
    }

    async.auto<AsyncResults>(
        {
            getSettings: (cb) => getSettings(cb),
            gitlabApi: [
                'getSettings',
                (results, cb) => {
                    console.log('>> POLLING GITLAB API');

                    if (!results.getSettings) {
                        return cb(new FailFetchSettings());
                    }

                    if (!results.getSettings.token) {
                        return cb(new GitLabTokenNotSet());
                    }

                    if (!results.getSettings.address) {
                        return cb(new GitLabAddressNotSet());
                    }

                    const api = new Gitlab({
                        host: results.getSettings.address,
                        token: results.getSettings.token
                    });

                    return cb(null, api);
                }
            ],
            reviewRequests: [
                'getSettings',
                'gitlabApi',
                (results, cb) => {
                    const { gitlabApi, getSettings } = results;

                    gitlabApi.MergeRequests.all({
                        state: 'opened',
                        scope: 'assigned_to_me',
                        wip: 'no'
                    })
                        .then((mrAssigned: MergeRequests[]) => {
                            return fetchMRExtraInfo(
                                {
                                    gitlabApi,
                                    mrList: mrAssigned,
                                    gitlabCE: getSettings.gitlabCE
                                },
                                (error, mrAssignedDetails) => {
                                    if (error) {
                                        return cb(error);
                                    }

                                    if (!mrAssignedDetails) {
                                        return cb(new FailFetchMergeRequestsAssigned());
                                    }

                                    let mrToReview = 0;
                                    mrAssignedDetails.forEach((mr) => {
                                        if (!mr.approvals.user_has_approved) {
                                            mrToReview += 1;
                                        }
                                    });

                                    return cb(null, {
                                        mrAssigned: mrAssignedDetails,
                                        mrToReview
                                    });
                                }
                            );
                        })
                        .catch((error: Error) => {
                            if (error) {
                                return cb(error);
                            }
                        });
                }
            ],
            givenRequests: [
                'getSettings',
                'gitlabApi',
                (results, cb) => {
                    const { gitlabApi, getSettings } = results;

                    gitlabApi.MergeRequests.all({
                        state: 'opened',
                        scope: 'created_by_me'
                    })
                        .then((mrGiven: MergeRequests[]) => {
                            return fetchMRExtraInfo(
                                {
                                    gitlabApi,
                                    mrList: mrGiven,
                                    gitlabCE: getSettings.gitlabCE
                                },
                                (error, mrGivenDetails) => {
                                    if (error) {
                                        return cb(error);
                                    }

                                    if (!mrGivenDetails) {
                                        return cb(new FailFetchMergeRequestsGiven());
                                    }

                                    let mrReviewed = 0;
                                    mrGivenDetails.forEach((mr) => {
                                        if (mr.approvals.approved) {
                                            mrReviewed += 1;
                                        }
                                    });

                                    return cb(null, {
                                        mrGiven: mrGivenDetails,
                                        mrReviewed
                                    });
                                }
                            );
                        })
                        .catch((error: Error) => {
                            if (error) {
                                return cb(error);
                            }
                        });
                }
            ],
            issuesAssigned: [
                'gitlabApi',
                (results, cb) => {
                    const { gitlabApi } = results;

                    gitlabApi.Issues.all({
                        state: 'opened',
                        scope: 'assigned_to_me'
                    })
                        .then((issues: Issue[]) => {
                            if (!issues) {
                                return cb(new FailFetchIssues());
                            }

                            return cb(null, issues);
                        })
                        .catch((error: Error) => {
                            if (error) {
                                return cb(error);
                            }
                        });
                }
            ],
            todos: [
                'gitlabApi',
                (results, cb) => {
                    const { gitlabApi } = results;

                    gitlabApi.Todos.all({
                        state: 'pending'
                    })
                        .then((todos: Todo[]) => {
                            if (!todos) {
                                return cb(new FailFetchTodos());
                            }

                            return cb(null, todos);
                        })
                        .catch((error: Error) => {
                            if (error) {
                                return cb(error);
                            }
                        });
                }
            ],
            updateBadge: [
                'getSettings',
                'reviewRequests',
                'givenRequests',
                'issuesAssigned',
                'todos',
                (results, cb) => {
                    const {
                        getSettings: { alertBadgeCounters },
                        reviewRequests: { mrToReview },
                        givenRequests: { mrReviewed },
                        issuesAssigned,
                        todos
                    } = results;

                    const badgeText = [];
                    let badgeColor = 'black';

                    if (alertBadgeCounters.includes(0) && (mrToReview > 0 || alertBadgeCounters.length > 1)) {
                        badgeText.push(mrToReview);
                        badgeColor = '#dc3545'; // red
                    }
                    if (alertBadgeCounters.includes(1) && (mrReviewed > 0 || alertBadgeCounters.length > 1)) {
                        badgeText.push(mrReviewed);
                        badgeColor = '#28a745'; // green
                    }
                    if (
                        alertBadgeCounters.includes(2) &&
                        (issuesAssigned.length > 0 || alertBadgeCounters.length > 1)
                    ) {
                        badgeText.push(issuesAssigned.length);
                        badgeColor = '#fd7e14'; // orange
                    }
                    if (alertBadgeCounters.includes(3) && (todos.length > 0 || alertBadgeCounters.length > 1)) {
                        badgeText.push(todos.length);
                        badgeColor = '#1f78d1'; // blue
                    }

                    setBadge(badgeText.length > 0 ? badgeText.join('⋅') : '', badgeColor);

                    return cb();
                }
            ],
            saveLocalStorage: [
                'reviewRequests',
                'givenRequests',
                'issuesAssigned',
                'todos',
                (results, cb) => {
                    const { mrAssigned, mrToReview } = results.reviewRequests;
                    const { mrGiven, mrReviewed } = results.givenRequests;
                    const { todos, issuesAssigned } = results;
                    const lastUpdateDateUnix = new Date().getTime();

                    browser.storage.local
                        .set({
                            mrAssigned,
                            mrToReview,
                            mrGiven,
                            mrReviewed,
                            issuesAssigned,
                            todos,
                            lastUpdateDateUnix
                        })
                        .then(() => cb())
                        .catch((error) => cb(error));
                }
            ]
        },
        (error) => {
            if (error) {
                console.error('Error in GetLastestDataFromGitLab #', error);
                setBadge('Error', 'red');
                return cb(error);
            }
            return cb();
        }
    );
};
